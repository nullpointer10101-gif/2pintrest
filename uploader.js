const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const db = require('./db');
const config = require('./config.json');

// Helper to wait randomly between min and max ms
const delay = (min, max) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1) + min)));

class PinterestUploader {
    constructor(accountName, sessionCookie, browser) {
        this.accountName = accountName;
        this.sessionCookie = sessionCookie;
        this.browser = browser;
    }

    async uploadPin(pinData) {
        console.log(`[Uploader - ${this.accountName}] Processing pin: ${pinData.title || pinData.id}`);
        const page = await this.browser.newPage();
        
        try {
            // Spoof User-Agent to prevent headless blocking
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            // Set the session cookie so we are logged in
            await page.setCookie({
                name: '_pinterest_sess',
                value: this.sessionCookie,
                domain: '.pinterest.com',
                path: '/',
                secure: true,
                httpOnly: true
            });

            // Navigate to Pin Creation page (Using Pinterest's standard UI builder)
            await page.goto('https://www.pinterest.com/pin-builder/', { waitUntil: 'domcontentloaded', timeout: 120000 });

            // Ensure we are actually logged in by waiting for the profile picture or account menu
            const isLoggedIn = await page.waitForSelector('div[data-test-id="header-profile"], div[data-test-id="saved-tab"]', { timeout: 30000 }).catch(() => null);
            if (!isLoggedIn) {
                console.error(`[Uploader - ${this.accountName}] Session cookie might be invalid. Not logged in. Current URL is: ${page.url()}`);
                await page.close();
                return false;
            }

            console.log(`[Uploader - ${this.accountName}] Pin-builder loaded successfully! Executing UI automation.`);
            
            // 1. Download image to temporary file
            const tmpImagePath = path.join(__dirname, `tmp_${Date.now()}.jpg`);
            const writer = fs.createWriteStream(tmpImagePath);
            const response = await axios({ url: pinData.image_url, method: 'GET', responseType: 'stream' });
            response.data.pipe(writer);
            await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });

            // 2. Upload image via input element
            const fileInput = await page.$('input[type="file"]');
            if (fileInput) {
                await fileInput.uploadFile(tmpImagePath);
                await delay(2000, 4000);
            }

            // 3. Type Title
            if (pinData.title) {
                const titleSelector = 'div[aria-label="Add your title"], input[placeholder*="title"], textarea[placeholder*="title"], [data-test-id="pin-builder-title"]';
                await page.waitForSelector(titleSelector, { timeout: 10000 }).catch(() => {});
                const titleEls = await page.$$(titleSelector);
                if (titleEls.length > 0) {
                    await titleEls[0].click();
                    await delay(500);
                    await titleEls[0].type(pinData.title, { delay: 50 });
                }
            }

            // 4. Type Description
            if (pinData.description) {
                const descSelector = 'div[aria-label="Tell everyone what your Pin is about"], textarea[placeholder*="Tell everyone"], [data-test-id="pin-builder-description"]';
                await page.waitForSelector(descSelector, { timeout: 10000 }).catch(() => {});
                const descEls = await page.$$(descSelector);
                if (descEls.length > 0) {
                    await descEls[0].click();
                    await delay(500);
                    await descEls[0].type(pinData.description, { delay: 30 });
                }
            }

            // 4.5. Select the Board
            if (pinData.board_name) {
                console.log(`[Uploader - ${this.accountName}] Trying to select board: "${pinData.board_name}"`);
                
                // Open board dropdown
                const dropdownOpened = await page.evaluate(() => {
                    const dropdowns = Array.from(document.querySelectorAll('[data-test-id="board-dropdown-select-button"], [data-test-id="board-dropdown-button"]'));
                    if (dropdowns.length > 0) { dropdowns[0].click(); return true; }
                    return false;
                });

                if (dropdownOpened) {
                    await delay(1000, 2000);
                    const selected = await page.evaluate((boardName) => {
                        // Look for exact board row
                        const rows = Array.from(document.querySelectorAll(`[data-test-id="board-row-${boardName}"]`));
                        if (rows.length > 0) { rows[0].click(); return true; }
                        
                        // Fallback: search all divs for the exact text
                        const allDivs = Array.from(document.querySelectorAll('div'));
                        for(let d of allDivs) {
                            if (d.innerText && d.innerText.trim().toLowerCase() === boardName.toLowerCase()) {
                                d.click(); return true;
                            }
                        }
                        return false;
                    }, pinData.board_name);
                    
                    if (selected) {
                        console.log(`[Uploader - ${this.accountName}] Successfully selected board: "${pinData.board_name}"`);
                    } else {
                        console.log(`[Uploader - ${this.accountName}] Board "${pinData.board_name}" not found in dropdown. Continuing with default.`);
                        // Close dropdown by pressing Escape
                        await page.keyboard.press('Escape');
                    }
                    await delay(1000, 2000);
                }
            }

            // 5. Click Publish
            const publishSelector = '[data-test-id="pwt-publish-button"], [data-test-id="board-dropdown-save-button"], button[aria-label="Publish"], button';
            const publishBtns = await page.$$(publishSelector);
            let publishBtn = null;
            for (let btn of publishBtns) {
                const text = await page.evaluate(el => el.innerText, btn);
                if (text && text.toLowerCase().includes('publish')) { publishBtn = btn; break; }
            }
            
            if (!publishBtn && publishBtns.length > 0) publishBtn = publishBtns[0]; // fallback

            if (publishBtn) {
                console.log(`[Uploader - ${this.accountName}] Clicking Publish...`);
                await publishBtn.click();
                
                console.log(`[Uploader - ${this.accountName}] Waiting for upload to complete...`);
                // Wait up to 20 seconds for the URL to change (meaning success)
                try {
                    await page.waitForNavigation({ timeout: 20000, waitUntil: 'networkidle2' });
                } catch(e) {
                    // Sometimes it doesn't navigate but shows a toast
                    await delay(5000);
                }
            } else {
                console.log(`[Uploader - ${this.accountName}] Could not find Publish button.`);
            }

            // Cleanup temp file
            if (fs.existsSync(tmpImagePath)) fs.unlinkSync(tmpImagePath);

            await page.close();
            return true;
        } catch (e) {
            console.error(`[Uploader - ${this.accountName}] Error uploading:`, e.message);
            await page.close();
            return false;
        }
    }
}

async function startUploaderLoop(maxPinsPerRun = 999999) {
    console.log(`[Uploader] Starting Continuous upload batch with Puppeteer...`);

    const browser = await puppeteer.launch({ 
        headless: true,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process',
            '--no-zygote',
            '--disable-notifications'
        ] 
    });

    // Initialize all uploader sessions
    const uploaders = {};
    for (const acc of config.destination_channels) {
        const sessionCookie = process.env.PINTEREST_SESSION_COOKIE || acc.session_cookie;
        uploaders[acc.name] = new PinterestUploader(acc.name, sessionCookie, browser);
    }

    let pinsProcessed = 0;

    while (pinsProcessed < maxPinsPerRun) {
        try {
            // Grab 1 pending pin from the queue
            const pin = await db.getNextPendingPin();
            
            if (!pin) {
                console.log('[Uploader] Queue is empty. All extracted pins have been posted.');
                break; // Exit the loop so GitHub Action can finish
            }

            const uploader = uploaders[pin.destination_channel_name];
            
            if (!uploader) {
                console.error(`[Uploader] Unrecognized channel: ${pin.destination_channel_name}.`);
                await db.updatePinStatus(pin.id, 'failed');
                continue;
            }

            const success = await uploader.uploadPin(pin);

            if (success) {
                await db.updatePinStatus(pin.id, 'success');
                console.log(`[Uploader] Successfully uploaded Pin #${pin.id}.`);
            } else {
                await db.updatePinStatus(pin, 'failed');
            }

            pinsProcessed++;

            if (pinsProcessed >= maxPinsPerRun) {
                break;
            }

        } catch (e) {
            console.error('[Uploader] Loop error:', e.message);
        }

        console.log(`[Uploader] Sleeping for 15 seconds before the next pin...`);
        await delay(15000, 15000); // Wait exactly 15 seconds
    }

    await browser.close();
    console.log('[Uploader] Batch complete.');
}

module.exports = {
    startUploaderLoop,
    PinterestUploader
};
