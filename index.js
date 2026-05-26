const cron = require('node-cron');
const { scrapeTargetChannels } = require('./scraper');
const { startUploaderLoop } = require('./uploader');

async function runOnce() {
    console.log('\n====================================');
    console.log(' Pinterest Standalone Mass Poster');
    console.log('====================================');

    // 1. Run the Harvester to find new pins
    await scrapeTargetChannels();

    // to the configured destination channels at a medium pace.
    await startUploaderLoop();
}

// If run with --cron argument, keep it alive forever and run hourly.
if (process.argv.includes('--cron')) {
    console.log('🚀 Starting bot in 24/7 Continuous Mode (runs every hour)');
    runOnce().catch(err => console.error('Error in initial run:', err));
    
    cron.schedule('0 * * * *', async () => {
        console.log(`\n⏰ [Cron] Triggering hourly run at ${new Date().toLocaleString()}`);
        await runOnce().catch(err => console.error('Error in cron run:', err));
    });
} 
// Web Server Mode (Best for free hosts like Render.com)
else if (process.argv.includes('--web') || process.env.RENDER) {
    const express = require('express');
    const app = express();
    const port = process.env.PORT || 3000;
    let isRunning = false;

    app.get('/', (req, res) => {
        res.send('Pinterest Bot is Awake and Running! 🟢');
    });

    app.get('/trigger', async (req, res) => {
        if (isRunning) return res.send('Bot is already currently running a batch.');
        res.send('Manual batch triggered! Check server logs.');
        isRunning = true;
        await runOnce().catch(err => console.error('Error:', err));
        isRunning = false;
    });

    app.listen(port, () => {
        console.log(`🚀 Web server started on port ${port}. Send a GET request to /trigger to run the bot.`);
        
        // Also schedule it to run automatically every hour internally
        cron.schedule('0 * * * *', async () => {
            if (isRunning) return;
            isRunning = true;
            await runOnce().catch(err => console.error('Error:', err));
            isRunning = false;
        });
    });
} 
// Just run once and exit
else {
    runOnce().catch(err => {
        console.error('Fatal Error:', err);
        process.exit(1);
    });
}
