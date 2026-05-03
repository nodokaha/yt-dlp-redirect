import express from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';

const execFileAsync = promisify(execFile);

const app = express();

function handleError(e: any): Error {
    if (e instanceof Error) {
        return e;
    } else if (typeof e === 'string') {
        return new Error(e);
    } else {
        return new Error('Unknown error');
    }
}

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

// prevents duplicate yt-dlp calls in-flight
const inFlight = new Map();

async function getStreamUrls(url: string) {
    const cached = cache.get(url);
    if (cached && cached.expires > Date.now()) {
        return cached.data;
    }

    // 🧠 dedupe concurrent requests
    if (inFlight.has(url)) {
        return inFlight.get(url);
    }

    const promise = (async () => {
        const args = ['-f', "best[ext=mp4][protocol=https]", '-g', url];
        const { stdout } = await execFileAsync('yt-dlp', args, { timeout: 15000 });
        const [videoUrl] = stdout.trim().split('\n');
        const data = { videoUrl };
        cache.set(url, {
            data,
            expires: Date.now() + CACHE_TTL
        });

        return data;
    })();

    inFlight.set(url, promise);

    try {
        return await promise;
    } catch (error) {
        console.error('Error fetching stream URLs:', error);
        throw error;
    } finally {
        inFlight.delete(url);
    }
}

// sub to any url
app.use(async (req, res) => {
    // the url is encoded with uri component, so we need to decode it
    const url = decodeURIComponent(req.url.substring(1)); // remove the leading '/'
    if (!url) {
        res.status(400).send('missing url');
        return;
    }
    // check if the url is valid
    let parsedUrl: URL;
    try {
        parsedUrl = new URL(url);
    } catch (e) {
        res.status(400).send('invalid url');
        return;
    }
    switch(parsedUrl.hostname) {
        case 'www.youtube.com':
        case 'youtube.com':
        case 'youtu.be':
            break;
        default:
            res.redirect(url);
            return;
    }

    console.log('Received request for URL:', url);

    const streamData = await getStreamUrls(url).catch(handleError);
    if(streamData instanceof Error) {
        console.error('Error fetching stream URLs:', streamData);
        res.status(502).send('failed to get media url');
        return;
    }
    
    const { videoUrl } = streamData;
    // console.log('Redirecting to:', videoUrl);
    // res.redirect(videoUrl);

    try {
        // --- forward Range header ---
        const headers: { [key: string]: string } = {};
        if (req.headers.range) {
            headers['Range'] = req.headers.range;
        }

        // --- fetch from Google ---
        const upstream = await fetch(videoUrl, { headers });

        // --- forward status (200 / 206) ---
        res.status(upstream.status);

        // --- forward important headers ---
        const passthroughHeaders = [
            'content-type',
            'content-length',
            'content-range',
            'accept-ranges'
        ];

        passthroughHeaders.forEach(h => {
            const v = upstream.headers.get(h);
            if (v) res.setHeader(h, v);
        });

        // --- stream body ---
        const body = upstream.body;
        if (body != null) {
            Readable.fromWeb(body).pipe(res);
        }
    } catch (err) {
        console.error(err);
        res.status(502).send('proxy failed');
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});