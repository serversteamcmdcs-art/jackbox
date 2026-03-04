const path = require('path');
const express = require('express');
const https = require('https');
const app = express();

// Proxy requests to a given HTTPS hostname
function proxyTo(hostname, fullPath, req, res) {
    const options = {
        hostname,
        port: 443,
        path: fullPath,
        method: 'GET',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': '*/*',
            'Accept-Encoding': 'identity',
        }
    };

    console.log(`[proxy] -> https://${hostname}${fullPath}`);

    const proxy = https.request(options, (proxyRes) => {
        console.log(`[proxy] <- ${proxyRes.statusCode} https://${hostname}${fullPath}`);
        const headers = { ...proxyRes.headers };
        delete headers['content-encoding'];
        delete headers['transfer-encoding'];
        res.writeHead(proxyRes.statusCode, headers);
        proxyRes.pipe(res, { end: true });
    });

    proxy.on('error', (err) => {
        console.error(`[proxy] ERROR https://${hostname}${fullPath} -`, err.message);
        res.status(502).send('Proxy error: ' + err.message);
    });

    proxy.end();
}

// Proxy /main/* game bundles -> jackbox.tv
// e.g. GET /main/@connect/script.js?v=... -> https://jackbox.tv/main/@connect/script.js?v=...
app.use('/main', (req, res) => {
    proxyTo('jackbox.tv', '/main' + req.url, req, res);
});

// Serve local static files (index.htm, script-0.js, style-0.css, icons, etc.)
app.use(express.static(path.join(__dirname, '/')));

// Root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.htm'));
});

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
    console.log(`Jackbox server listening on port ${PORT}`);
});
