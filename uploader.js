const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const db = require('./db');
const config = require('./config.json');

// Helper to wait randomly between min and max ms
const delay = (min, max = min) => new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1) + min)));

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
            await page.goto('https://www.pinterest.com/pin-creation-tool/', { waitUntil: 'domcontentloaded', timeout: 120000 });

            // Ensure we are actually logged in by waiting for the profile picture or account menu
            const isLoggedIn = await page.waitForSelector('div[data-test-id="header-profile"], div[data-test-id="saved-tab"], button[data-test-id="header-accounts-options-button"]', { timeout: 30000 }).catch(() => null);
            if (!isLoggedIn) {
                console.error(`[Uploader - ${this.accountName}] Session cookie might be invalid. Not logged in. Current URL is: ${page.url()}`);
                await page.close();
                return false;
            }

            console.log(`[Uploader - ${this.accountName}] Pin-builder loaded successfully! Executing UI automation.`);
            
            // 1. Download image/video to temporary file
            const isMp4 = pinData.image_url.includes('.mp4');
            const fileExt = isMp4 ? '.mp4' : '.jpg';
            const tmpImagePath = path.join(__dirname, `tmp_${Date.now()}${fileExt}`);
            const writer = fs.createWriteStream(tmpImagePath);
            const response = await axios({ url: pinData.image_url, method: 'GET', responseType: 'stream' });
            response.data.pipe(writer);
            await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });

            // 2. Upload media via input element
            await page.waitForSelector('input[type="file"], input[id="storyboard-upload-input"]', { timeout: 15000 }).catch(()=>{});
            let fileInput = await page.$('input[type="file"]');
            if (!fileInput) fileInput = await page.$('input[id="storyboard-upload-input"]');
            
            if (fileInput) {
                await fileInput.uploadFile(tmpImagePath);
                if (isMp4) {
                    console.log(`[Uploader - ${this.accountName}] Video file selected. Waiting 15 seconds for initial processing...`);
                    await delay(15000, 20000);
                } else {
                    await delay(2000, 4000);
                }
            }

            // 3. Type Title
            await page.waitForSelector('textarea[id="storyboard-selector-title"], input[id="storyboard-selector-title"]', { timeout: 10000 }).catch(()=>{});
            let titleSelector = null;
            if (await page.$('input[id="storyboard-selector-title"]')) titleSelector = 'input[id="storyboard-selector-title"]';
            else if (await page.$('textarea[id="storyboard-selector-title"]')) titleSelector = 'textarea[id="storyboard-selector-title"]';
            
            if (titleSelector) {
                await page.type(titleSelector, pinData.title || 'Inspiration', { delay: 50 });
            }
            await delay(1500, 2500);

            // 4. Type Description
            if (pinData.description) {
                // Let's use evaluate to inject text to avoid formatting issues
                await page.evaluate((desc) => {
                    const draftContainers = document.querySelectorAll('div[data-test-id*="pin-draft-description"]');
                    let target = null;
                    if (draftContainers.length > 0) {
                        target = draftContainers[0].querySelector('div[contenteditable="true"]') || draftContainers[0];
                    } else {
                        target = document.querySelector('div[contenteditable="true"]') || document.querySelector('textarea[placeholder*="description"]');
                    }
                    if (target) {
                        target.focus();
                        document.execCommand('insertText', false, desc);
                    }
                }, pinData.description);
                await delay(1500, 2500);
            }

            // 4.2 Type Link
            if (pinData.link) {
                await page.evaluate((link) => {
                    const inputs = Array.from(document.querySelectorAll('textarea, input'));
                    const linkInput = inputs.find(el => el.placeholder && (el.placeholder.toLowerCase().includes('link') || el.id === 'WebsiteField'));
                    if (linkInput) {
                        linkInput.value = link;
                        linkInput.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }, pinData.link);
                await delay(1000, 1500);
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
                    // Check if there is an error popup on the screen
                    const errorPopupText = await page.evaluate(() => {
                        return document.body.innerText;
                    });
                    
                    if (errorPopupText && errorPopupText.toLowerCase().includes('published a lot today')) {
                        console.error(`[Uploader - ${this.accountName}] PINTEREST DAILY LIMIT REACHED! You must wait 24 hours.`);
                        await page.close();
                        return false; 
                    }

                    // Otherwise assume it might have succeeded without navigating (toast)
                    await delay(5000);
                }
            } else {
                console.log(`[Uploader - ${this.accountName}] Could not find Publish button.`);
                await page.close();
                return false;
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
