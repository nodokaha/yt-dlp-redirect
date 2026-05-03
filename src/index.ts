import express from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const app = express();


// sub to any url
app.use(async (req, res) => {
    // the url is encoded with uri component, so we need to decode it
    const url = decodeURIComponent(req.url.substring(1)); // remove the leading '/'
    if (!url) {
        res.status(400).send('missing url');
        return;
    }

    console.log('Received request for URL:', url);

    try {
        // ask yt-dlp to print a direct mp4 playback URL
        // -g prints the direct URL; prefer mp4 if available
        const args = ['-f', "best[ext=mp4][protocol=https]", '-g', url];
        const { stdout } = await execFileAsync('yt-dlp', args, { timeout: 15000 });
        const redirectUrl = stdout.toString().split('\n')[0].trim();
        if (!redirectUrl) {
            res.status(502).send('no playable url');
            console.error('No playable URL found for:', url);
            return;
        }
        console.log('Redirecting to:', redirectUrl);
        res.redirect(redirectUrl);
    } catch (err) {
        console.error('yt-dlp error', err);
        res.status(502).send('failed to get media url');
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});