const express = require('express');
const app = express();

app.get('/api/test', (req, res) => {
  res.json({ ok: true });
});

app.get('*', (req, res) => {
  res.send('fallback');
});

app.listen(5199, () => {
  const http = require('http');

  http.get('http://localhost:5199/api/test', (r) => {
    let d = '';
    r.on('data', c => d += c);
    r.on('end', () => {
      console.log('/api/test response:', d);
      http.get('http://localhost:5199/api/other', (r2) => {
        let d2 = '';
        r2.on('data', c => d2 += c);
        r2.on('end', () => {
          console.log('/api/other response:', d2);
          process.exit(0);
        });
      });
    });
  });
});