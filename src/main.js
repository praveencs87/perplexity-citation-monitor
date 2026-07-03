import { armKillSwitch, disarmKillSwitch } from './utils/timeoutManager.js';
import { Actor } from 'apify';
import { PlaywrightCrawler, log } from 'crawlee';

await Actor.init();

try {
    const input = await Actor.getInput();
    const { queries, targetDomain, proxyConfiguration } = input;

    if (!queries || queries.length === 0) {
        throw new Error('queries array is required!');
    }

    log.info(`Starting Perplexity Citation Monitor for ${queries.length} queries.`);

    // PPE: Base charge for starting
    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    const proxyConfig = await Actor.createProxyConfiguration(proxyConfiguration || { useApifyProxy: true });

    let extractedCount = 0;

    const crawler = new PlaywrightCrawler({
        proxyConfiguration: proxyConfig,
        // Headless browser options
        launchContext: {
            launchOptions: {
                args: ['--disable-blink-features=AutomationControlled'],
            }
        },
        maxConcurrency: 2, // Keep concurrency low to prevent captchas
        async requestHandler({ page, request, log }) {
            const query = request.userData.query;
            log.info(`🔍 Searching: "${query}"`);

            // Wait for the AI answer to generate. 
            // Perplexity dynamically streams the answer, we wait for a specific container to appear.
            // Usually, the answer is within a main container, and citations are listed at the top or inline.
            
            // Wait for network to be somewhat idle, meaning the streaming might have finished.
            // A more robust way is waiting for the copy button or the "Ask follow-up" input to become enabled.
            try {
                // Try waiting for the main text block
                await page.waitForSelector('div[dir="auto"]', { state: 'visible', timeout: 30000 });
                // Give it extra time for the stream to complete and sources to load
                await page.waitForTimeout(5000);
            } catch (e) {
                log.warning(`Timeout waiting for standard answer selectors on query: ${query}`);
            }

            // Extract Answer Text
            // Perplexity usually wraps the answer in 'prose' or 'break-words' classes
            let answerText = '';
            try {
                answerText = await page.evaluate(() => {
                    const textBlocks = Array.from(document.querySelectorAll('div[dir="auto"]'));
                    return textBlocks.map(b => b.innerText).join('\n\n');
                });
            } catch (e) {
                log.error(`Failed to extract text: ${e.message}`);
            }

            // Extract Citations
            // Perplexity sources are usually external links
            let citations = [];
            try {
                citations = await page.evaluate(() => {
                    const links = Array.from(document.querySelectorAll('a[href^="http"]'));
                    // Filter out internal perplexity links
                    const external = links.filter(a => !a.href.includes('perplexity.ai'));
                    // Map to URLs and remove duplicates
                    const uniqueUrls = [...new Set(external.map(a => a.href))];
                    return uniqueUrls;
                });
            } catch (e) {
                log.error(`Failed to extract citations: ${e.message}`);
            }

            let brandMentioned = false;
            if (targetDomain) {
                brandMentioned = citations.some(url => url.toLowerCase().includes(targetDomain.toLowerCase()));
            }

            const record = {
                query,
                url: request.url,
                scrapedAt: new Date().toISOString(),
                brandMentioned,
                citationsCount: citations.length,
                citations,
                answerText: answerText.substring(0, 1000) + (answerText.length > 1000 ? '...' : '') // Truncate very long answers
            };

            await Actor.pushData(record);
            
            // PPE: Charge per query monitored
            await Actor.charge({ eventName: 'query-monitored', count: 1 });
            extractedCount++;
            
            log.info(`✅ Successfully monitored: "${query}" | Citations found: ${citations.length} | Brand Mentioned: ${brandMentioned}`);
        },
        async failedRequestHandler({ request, log }) {
            log.error(`Request ${request.url} failed too many times.`);
        },
    });

    const initialRequests = queries.map(query => ({
        url: `https://www.perplexity.ai/search?q=${encodeURIComponent(query)}`,
        userData: { query }
    }));
    
    await crawler.addRequests(initialRequests);
    armKillSwitch(crawler);
    await crawler.run();
    disarmKillSwitch();

    log.info(`🎉 Successfully monitored ${extractedCount} queries!`);
} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
