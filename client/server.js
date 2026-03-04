const path = require('path');
const express = require('express');
const app = express();

app.use(express.static(path.join(__dirname, '/')));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.htm'));
});

const PORT = process.env.PORT || 3333;
app.listen(PORT, () => {
    console.log(`Jackbox server listening on port ${PORT}`);
});
