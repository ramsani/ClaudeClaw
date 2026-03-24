#!/usr/bin/env node
const http = require('http');
const { spawn } = require('child_process');

const PORT = 5679;
const HOST = '0.0.0.0';

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  if (req.method === 'POST' && req.url === '/execute') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { command } = JSON.parse(body);
        if (!command) {
          res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'No command provided' }));
          return;
        }

        // Execute claude with the MiniMax script
        const claudeCmd = `source ~/claude-minimax.sh 2>/dev/null || true && claude -p '${command.replace(/'/g, "'\\''")}' --session telegram --output-format json`;

        const proc = spawn('bash', ['-c', claudeCmd]);

        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', data => { stdout += data; });
        proc.stderr.on('data', data => { stderr += data; });

        proc.on('close', code => {
          const output = stdout + (stderr ? '\n' + stderr : '');
          res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ output, exitCode: code }));
        });

        proc.on('error', err => {
          res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: err.message }));
        });

        // Timeout after 3 minutes
        setTimeout(() => {
          proc.kill();
          res.writeHead(504, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
          res.end(JSON.stringify({ error: 'Timeout' }));
        }, 180000);

      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Claude server running on http://${HOST}:${PORT}`);
  console.log('Send POST to /execute with { "command": "your message" }');
});
