import fs from "fs";

const files = [
  "src/browser/status-badge.ts",
  "src/browser/console-overlay.ts"
];

for (const file of files) {
  let s = fs.readFileSync(file, "utf8");

  s = s.replace(
    "badge.innerHTML = html;",
    "badge.textContent = html;"
  );

  s = s.replace(
/buttons\.innerHTML = `[\s\S]*?`;/,
`['#ff5f56', '#ffbd2e', '#27c93f'].forEach((color) => {
      const dot = document.createElement('div');
      dot.style.cssText = \`width:12px;height:12px;border-radius:50%;background:\${color};\`;
      buttons.appendChild(dot);
    });`
  );

  s = s.replace(
    "content.insertAdjacentHTML('beforeend', markup);",
`const line = document.createElement('div');
      line.textContent = markup.replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim();
      content.appendChild(line);`
  );

  s = s.replace(
    "if (content) content.innerHTML = '';",
    "if (content) content.textContent = '';"
  );

  fs.writeFileSync(file, s, "utf8");
}
