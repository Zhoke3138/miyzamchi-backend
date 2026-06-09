const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// 1. Remove convertDocxToHtml completely
code = code.replace(/const convertDocxToHtml\s*=\s*async\s*\([^)]*\)\s*=>\s*\{[\s\S]*?throw new Error\([^)]*\);\s*\};\r?\n/m, '');

// 2. We also need to fix openFile handler.
// Since App.jsx is minified, we can find the start and end of the block.
const searchStr = `payload.getFile().then(async file=>{if(file.name.endsWith('.docx')){try{const buffer=await file.arrayBuffer();let html;if(true){html=await convertDocxToHtml(buffer)}`;

// We know it ends with `catch(e){addToast('warning','Ошибка парсинга DOCX');console.error(e)}}`
const endStr = `catch(e){addToast('warning','Ошибка парсинга DOCX');console.error(e)}}`;

const startIndex = code.indexOf(searchStr);
if (startIndex !== -1) {
  const endIndex = code.indexOf(endStr, startIndex);
  if (endIndex !== -1) {
    const fullMatch = code.substring(startIndex, endIndex + endStr.length);
    
    // Replace it with the new logic
    const newBlock = `payload.getFile().then(async file=>{if(file.name.endsWith('.docx')){try{const buffer=await file.arrayBuffer();const id='doc_'+(++_tabIdCounter);setTabs(p=>[...p,{id,name:payload.name,mod:false,content:'',handle:payload,buffer}]);switchTab(id);addRecent(payload.name);addToast('file','Открыт: '+payload.name)}catch(e){addToast('warning','Ошибка чтения DOCX');console.error(e)}}`;
    
    code = code.replace(fullMatch, newBlock);
    console.log('Successfully replaced openFile block!');
  } else {
    console.log('Could not find the end of openFile block!');
  }
} else {
  console.log('Could not find the start of openFile block!');
}

fs.writeFileSync('src/App.jsx', code);
console.log('File updated.');
