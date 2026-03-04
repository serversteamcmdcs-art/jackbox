const path = require('path');
const express = require('express');
const https = require('https');
const app = express();

// Proxy requests to jackbox.fun (CDN for game bundles)
function proxyRequest(req, res, fullPath) {
    const options = {
        hostname: 'jackbox.fun',
        port: 443,
        path: fullPath,
        method: req.method,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
            'Referer': 'https://jackbox.fun/',
            'Origin': 'https://jackbox.fun',
        }
    };

    const proxy = https.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });

    proxy.on('error', (err) => {
        console.error(`[proxy] Error proxying ${fullPath}:`, err.message);
        res.status(502).send('Proxy error');
    });

    req.pipe(proxy, { end: true });
}

// Proxy all /main/* game bundle requests to jackbox.fun
app.use('/main', (req, res) => {
    proxyRequest(req, res, '/main' + req.url);
});

// Serve local static files (index.htm, script-0.js, style-0.css, icons, etc.)
app.use(express.static(path.join(__dirname, '/')));

// Proxy /gtag/* to Google Tag Manager via jackbox.fun
app.use('/gtag', (req, res) => {
    proxyRequest(req, res, '/gtag' + req.url);
});

app.get('/', (req, res) => {
    res.sendFile(`${__dirname}/index.htm`);
});

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
    console.log(`Application listening on port ${PORT}!`);
});
