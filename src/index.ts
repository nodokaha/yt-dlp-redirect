import express from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';

const execFileAsync = promisify(execFile);
const app = express();

function handleError(e: any): Error {
    if (e instanceof Error) return e;
    if (typeof e === 'string') return new Error(e);
    return new Error('Unknown error');
}

const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour
const inFlight = new Map();

async function getStreamUrls(url: string) {
    const cached = cache.get(url);
    if (cached && cached.expires > Date.now()) {
        return cached.data;
    }

    if (inFlight.has(url)) {
        return inFlight.get(url);
    }

    const promise = (async () => {
        const args = [
            '--no-playlist', 
            '-f', 'best[ext=mp4][protocol=https]/best', 
            '-j', 
            url
        ];
        
        const { stdout } = await execFileAsync('yt-dlp', args, { timeout: 15000 });
        const videoInfo = JSON.parse(stdout.trim());

        let videoUrl = videoInfo.url || ''; 
        let isLive = false;

        if (
            videoInfo.is_live === true || 
            videoInfo.live_status === 'is_live' ||
            (typeof videoUrl === 'string' && videoUrl.includes('manifest/hls_playlist')) || 
            (typeof videoInfo.protocol === 'string' && videoInfo.protocol.includes('m3u8'))
        ) {
            isLive = true;
        }

        if (!videoUrl && Array.isArray(videoInfo.formats)) {
            const suitableFormat = videoInfo.formats.reverse().find((f: any) => 
                f.url && typeof f.protocol === 'string' && f.protocol.startsWith('http')
            );
            if (suitableFormat) {
                videoUrl = suitableFormat.url;
            }
        }

        if (!videoUrl) {
            throw new Error('動画のURLを抽出できませんでした。');
        }

        const data = { videoUrl, isLive };
        
        cache.set(url, { data, expires: Date.now() + CACHE_TTL });
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

app.use(async (req, res) => {
    const url = decodeURIComponent(req.url.substring(1));
    if (!url) {
        res.status(200).send('missing url');
        return;
    }

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
    
    const { videoUrl, isLive } = streamData;

    if (isLive) {
        console.log('Detected Live. Redirecting to HLS URL:', videoUrl);
        res.redirect(videoUrl);
    } else {
        console.log('Detected Normal Video. Proxying stream (original behavior)...');
        
        try {
            const abortController = new AbortController();
            
            req.on('close', () => {
                abortController.abort();
            });

            const headers: { [key: string]: string } = {};
            if (req.headers.range) {
                headers['Range'] = req.headers.range;
            }

            const upstream = await fetch(videoUrl, { 
                headers,
                signal: abortController.signal
            });

            res.status(upstream.status);

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

            const body = upstream.body;
            if (body != null) {
                const nodeStream = Readable.fromWeb(body as any);
                nodeStream.pipe(res);

                nodeStream.on('error', (err: any) => {
                    if (err.name !== 'AbortError' && err.code !== 'ECONNRESET') {
                        console.error('Stream error:', err);
                    }
                });
            }
        } catch (err: any) {
            if (err.name === 'AbortError') {
                console.log('Request aborted by client.');
                return;
            }
            console.error(err);
            if (!res.headersSent) {
                res.status(502).send('proxy failed');
            }
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
