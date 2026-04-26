const fs = require('fs');
const content = fs.readFileSync('server.js', 'utf-8');
const lines = content.split('\n');

let result = [];
let skipMode = false;
let spaCount = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  
  if (line.includes('// ========== SPA 前端路由兜底 ==========') || line.includes('SPA 前端路由兜底')) {
    spaCount++;
    if (spaCount === 1) {
      skipMode = true;
      console.log(`跳过旧块: 行 ${i+1}`);
      continue;
    }
    if (spaCount === 2) {
      skipMode = false;
      console.log(`保留正确块: 行 ${i+1}`);
    }
  }
  
  if (!skipMode) {
    result.push(line);
  }
}

fs.writeFileSync('server.js', result.join('\n'));
console.log(`完成! ${lines.length} -> ${result.length} 行`);