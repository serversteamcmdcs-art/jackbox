const path = require('path');
const express = require('express');
const app = express();

app.use(express.static(path.join(__dirname, '/')))
app.use(express.static(path.join(__dirname, '/gtag/')))
app.use(express.static(path.join(__dirname, '/client/')))

app.get('/', (req, res) => {
    res.sendFile(`${__dirname}/index.htm`);
});

app.listen(3333, () => {
    console.log('Application listening on port 3333!');
});
