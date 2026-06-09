const fs = require('fs');
let code = fs.readFileSync('src/App.jsx', 'utf8');

// The code we want to move:
// const[leftOpen,setLeftOpen]=useState(true);const[rightOpen,setRightOpen]=useState(true);const[splitActive,setSplitActive]=useState(false);
// const[actPanel,setActPanel]=useState('law');const[hilite,setHilite]=useState(null);

const strToMove = `  const[leftOpen,setLeftOpen]=useState(true);const[rightOpen,setRightOpen]=useState(true);const[splitActive,setSplitActive]=useState(false);\n  const[actPanel,setActPanel]=useState('law');const[hilite,setHilite]=useState(null);`;

// Regex to find it regardless of \r\n
const regexMove = /^[ \t]*const\[leftOpen,setLeftOpen\]=useState\(true\);const\[rightOpen,setRightOpen\]=useState\(true\);const\[splitActive,setSplitActive\]=useState\(false\);\r?\n[ \t]*const\[actPanel,setActPanel\]=useState\('law'\);const\[hilite,setHilite\]=useState\(null\);/m;

// Find it and replace it with a comment
if (regexMove.test(code)) {
    code = code.replace(regexMove, '  // state moved up');
    
    // Inject it near the top of App
    const targetAnchor = /^[ \t]*const\[npaCollapsed,setNpaCollapsed\]=useState\(false\);const\[chatCollapsed,setChatCollapsed\]=useState\(false\);/m;
    code = code.replace(targetAnchor, match => match + '\n' + strToMove);
    
    fs.writeFileSync('src/App.jsx', code);
    console.log('TDZ bug fixed in App.jsx');
} else {
    console.log('Could not find the target string to move.');
}
