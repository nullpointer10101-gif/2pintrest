const puppeteer = require('puppeteer');
const db = require('./db');
const config = require('./config.json');

async function waitMs(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function captureJsonResponse(page, urlFragment) {
    return new Promise((resolve) => {
        const timeout = setTimeout(() => resolve(null), 15000);
        page.once('response', async (res) => {
            if (res.url().includes(urlFragment)) {
                clearTimeout(timeout);
                try {
                    const text = await res.text();
                    resolve(JSON.parse(text));
                } catch(e) {
                    resolve(null);
                }
            }
        });
    });
}

async function scrapeTargetChannels() {
    console.log('[Scraper] Starting Puppeteer Harvester...');
    
    const browser = await puppeteer.launch({ 
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });
    const page = await browser.newPage();
    
    // Spoof User-Agent to prevent headless blocking
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // Block heavy resources to save RAM and CPU on Render Free Tier
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const type = req.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
            req.abort();
        } else {
            req.continue();
        }
    });
    
    // Inject session cookie
    const sessionCookie = process.env.PINTEREST_SESSION_COOKIE || config.destination_channels[0].session_cookie;
    if (sessionCookie && sessionCookie !== "USE_ENV_VARIABLE") {
        await page.setCookie({
            name: '_pinterest_sess',
            value: sessionCookie,
            domain: '.pinterest.com'
        });
        console.log('[Scraper] Session cookie injected.');
    }

    let destinationIndex = 0;
    const destChannels = config.destination_channels;
    let totalInserted = 0;

    for (const targetUrl of config.target_channels) {
        const destAccount = destChannels[destinationIndex % destChannels.length].name;
        console.log(`\n[Scraper] ── Target: ${targetUrl} → Queue: ${destAccount}`);
        
        try {
            // ── STEP 1: Visit the profile/board URL and collect board list ──
            const allBoards = [];

            const boardListener = async (res) => {
                if (res.url().includes('BoardsResource/get')) {
                    try {
                        const json = await res.json();
                        const boards = json?.resource_response?.data || [];
                        boards.forEach(b => {
                            if (b && b.url && b.name) {
                                allBoards.push({ name: b.name, url: b.url });
                            }
                        });
                        console.log(`[Scraper] Captured ${boards.length} boards from BoardsResource.`);
                    } catch(e) {}
                }
            };

            page.on('response', boardListener);
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
            await waitMs(4000); // Wait for lazy API calls
            page.off('response', boardListener);

            const finalUrl = page.url();
            console.log(`[Scraper] Resolved to: ${finalUrl}`);

            // Check if we landed on a board page directly (not a profile)
            const urlPath = new URL(finalUrl).pathname; // e.g., /aesthetichomedecorinspo/
            const isBoard = finalUrl.match(/pinterest\.com\/[^/]+\/[^/]+\/?$/) && !finalUrl.includes('?');
            
            // Extract the target username from the path
            const pathParts = urlPath.split('/').filter(Boolean);
            const targetUsername = pathParts[0];

            // Wait extra time for the profile page to render its boards
            await waitMs(6000);

            // Fallback: ALWAYS try extracting them directly from the DOM and merge!
            console.log(`[Scraper] Merging DOM boards with API boards (currently ${allBoards.length})...`);
            const domBoards = await page.evaluate((uname) => {
                const links = Array.from(document.querySelectorAll('a'));
                const boards = [];
                const seen = new Set();
                links.forEach(a => {
                    let href = a.getAttribute('href');
                    if (!href) return;
                    
                    // Handle absolute URLs by extracting pathname
                    if (href.startsWith('http')) {
                        try { href = new URL(href).pathname; } catch(e) {}
                    }
                    
                    // A board URL looks like /username/board-name/
                    // Make it case insensitive for uname
                    if (href.toLowerCase().startsWith(`/${uname.toLowerCase()}/`) && href.split('/').length >= 4) {
                        if (!seen.has(href)) {
                            seen.add(href);
                            // The board name is the 3rd segment
                            const boardSegment = href.split('/')[2];
                            if (boardSegment && boardSegment.length > 0) {
                                boards.push({ 
                                    name: boardSegment.replace(/-/g, ' '), 
                                    url: href 
                                });
                            }
                        }
                    }
                });
                return boards;
            }, targetUsername);
            
            domBoards.forEach(db => {
                if (!allBoards.find(ab => ab.url === db.url)) {
                    allBoards.push(db);
                }
            });

            // FILTER: Only keep boards that actually belong to the target username.
            // (This prevents accidentally scraping the logged-in user's own boards!)
            const targetBoards = allBoards.filter(b => b.url.startsWith(`/${targetUsername}/`));

            if (targetBoards.length === 0) {
                console.log('[Scraper] No boards found for this target. Skipping.');
                destinationIndex++;
                continue;
            }

            console.log(`[Scraper] Found ${targetBoards.length} boards belonging to ${targetUsername} to scrape.`);

            // ── STEP 2: Visit each board and intercept BoardFeedResource ──
            let channelPinCount = 0;
            for (const board of targetBoards) {
                if (channelPinCount >= config.max_pins_per_board) break;

                const boardUrl = board.url.startsWith('http') 
                    ? board.url 
                    : `https://www.pinterest.com${board.url}`;
                console.log(`[Scraper]   → Board: "${board.name}" (${boardUrl})`);

                const boardPins = [];

                const pinListener = async (res) => {
                    if (res.url().includes('BoardFeedResource')) {
                        try {
                            const json = await res.json();
                            const items = json?.resource_response?.data || [];
                            items.forEach(item => {
                                if (item?.type === 'pin' && item?.id && item?.images) {
                                    let mediaUrl = null;
                                    
                                    // 1. Check if it's a video and try to extract the highest quality MP4
                                    if (item.videos && item.videos.video_list) {
                                        const vList = item.videos.video_list;
                                        // Prefer higher resolution MP4s
                                        const preferredFormats = ['V_1080P', 'V_720P', 'V_EXP6', 'V_EXP5', 'V_EXP4', 'V_EXP3', 'V_HLSV4_MAC'];
                                        for (const fmt of preferredFormats) {
                                            if (vList[fmt] && vList[fmt].url && vList[fmt].url.endsWith('.mp4')) {
                                                mediaUrl = vList[fmt].url;
                                                break;
                                            }
                                        }
                                        // Fallback to any MP4 in the list
                                        if (!mediaUrl) {
                                            for (const key in vList) {
                                                if (vList[key].url && vList[key].url.endsWith('.mp4')) {
                                                    mediaUrl = vList[key].url;
                                                    break;
                                                }
                                            }
                                        }
                                    }

                                    // 2. If no video found, extract the static image
                                    if (!mediaUrl && item.images) {
                                        const imgObj = item.images.orig || item.images['736x'] || Object.values(item.images)[0] || {};
                                        mediaUrl = imgObj.url;
                                    }

                                    if (mediaUrl) {
                                        boardPins.push({
                                            id: String(item.id),
                                            image_url: mediaUrl,
                                            title: item.title || item.grid_title || '',
                                            description: item.description || '',
                                            board_name: board.name
                                        });
                                    }
                                }
                            });
                            console.log(`[Scraper]     Captured ${items.length} items from BoardFeedResource (running total: ${boardPins.length})`);
                        } catch(e) {}
                    }
                };

                page.on('response', pinListener);
                await page.goto(boardUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
                await waitMs(5000);
                page.off('response', pinListener);

                // Fallback: If network intercept missed it (cache/serviceworker), extract from DOM
                if (boardPins.length === 0) {
                    console.log(`[Scraper]     No pins caught from network for "${board.name}", trying DOM extraction...`);
                    const domPins = await page.evaluate((bName) => {
                        const pins = [];
                        const pinElements = document.querySelectorAll('[data-test-id="pin"]');
                        pinElements.forEach(pinEl => {
                            const img = pinEl.querySelector('img');
                            const link = pinEl.closest('a') || pinEl.querySelector('a');
                            if (img && link) {
                                const href = link.getAttribute('href');
                                if (href && href.includes('/pin/')) {
                                    const pinId = href.split('/pin/')[1].replace('/', '');
                                    let highResUrl = img.src;
                                    if (img.srcset) {
                                        const sources = img.srcset.split(',');
                                        const bestSource = sources[sources.length - 1].trim().split(' ')[0];
                                        if (bestSource) highResUrl = bestSource;
                                    }
                                    pins.push({
                                        id: pinId,
                                        image_url: highResUrl.replace(/236x|474x|736x/, 'originals'),
                                        title: img.getAttribute('alt') || '',
                                        description: '',
                                        board_name: bName
                                    });
                                }
                            }
                        });
                        return pins;
                    }, board.name);
                    boardPins.push(...domPins);
                }

                // Deduplicate
                const seen = new Set();
                const unique = boardPins.filter(p => {
                    if (seen.has(p.id)) return false;
                    seen.add(p.id);
                    return true;
                });

                console.log(`[Scraper]     → ${unique.length} unique pins from board "${board.name}"`);

                let inserted = 0;
                for (const pin of unique) {
                    if (channelPinCount >= config.max_pins_per_board) break;
                    const ok = await db.insertPin(pin, destAccount);
                    if (ok) { inserted++; channelPinCount++; totalInserted++; }
                }
                console.log(`[Scraper]     → Inserted ${inserted} new pins into queue.`);
            }

            console.log(`[Scraper] Done with target. Total pins queued for ${destAccount}: ${channelPinCount}`);

        } catch (error) {
            console.error(`[Scraper] Failed to scrape ${targetUrl}:`, error.message);
        }

        destinationIndex++;
    }

    await browser.close();
    console.log(`\n[Scraper] Harvesting complete. Grand total inserted: ${totalInserted} pins.`);
}

module.exports = { scrapeTargetChannels };
