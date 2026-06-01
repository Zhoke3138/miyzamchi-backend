const fs = require('fs');
const content = fs.readFileSync('index.html', 'utf8');
const lines = content.split('\n');
let insideVoiceModal = false;
lines.forEach((line, idx) => {
    if (line.includes('id="voice-modal"') || line.includes('voice-modal-close') || line.includes('class="voice-modal"')) {
        insideVoiceModal = true;
    }
    if (insideVoiceModal) {
        console.log(`${idx+1}: ${line.trim()}`);
        if (line.includes('</div>') && idx > 500) {
            // we will print around 30 lines
        }
    }
});
