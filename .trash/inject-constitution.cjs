const fs = require('fs');
const p = 'D:/agent-cli/nexus-desktop/src/agent/service.ts';
let s = fs.readFileSync(p, 'utf8');

const old =
  "            const constitution = await loadConstitution(projectDir ?? process.cwd());\r\n" +
  "            if (constitution.reason === 'ok' && constitution.text) {\r\n" +
  "              if (!firstContent.includes(CONSTITUTION_MARKER)) {\r\n" +
  "                ctx.prependToSystem(\r\n" +
  "                  `\\n\\n${CONSTITUTION_MARKER}\\n${constitution.text}\\n${CONSTITUTION_MARKER}\\n`,\r\n" +
  "                );\r\n" +
  "              }\r\n" +
  "            } else if (constitution.reason === 'too-large') {";

const ins =
  "            let text = this.constitutionOverride !== undefined ? (this.constitutionOverride || null) : null;\r\n" +
  "            if (!text) {\r\n" +
  "              // Sub-agent sessions (Orchestrator §3.7): override is set, so we\r\n" +
  "              // NEVER discover the constitution via the filesystem in the worker.\r\n" +
  "              const constitution = await loadConstitution(projectDir ?? process.cwd());\r\n" +
  "              if (constitution.reason === 'ok' && constitution.text) text = constitution.text;\r\n" +
  "              else if (constitution.reason === 'too-large') {";

const n = s.indexOf(old);
console.log('idx', n);
if (n < 0) {
  console.log('pattern not found');
  process.exit(1);
}
s = s.slice(0, n) + ins + s.slice(n + old.length);

// Now rewrite the subsequent tail block to use `text` and drop the else-if chain.
const old2 =
  "              this.onLog?.('warn', `Constitution at ${constitution.file} > 32 KB — refused (no silent context bloat)`);\r\n" +
  "            } else if (constitution.reason === 'unauthorized') {\r\n" +
  "              this.onLog?.('debug', 'Constitution skipped: project root not authorized');\r\n" +
  "            } else if (firstContent.includes(CONSTITUTION_MARKER)) {\r\n" +
  "              // Rule set removed / no longer resolvable — clear the block.\r\n" +
  "              ctx.replaceSystemByMarker(CONSTITUTION_MARKER, null);\r\n" +
  "            }\r\n" +
  "          } catch {";

const old2b =
  "              this.onLog?.('warn', `Constitution at ${constitution.file} > 32 KB — refused (no silent context bloat)`);\r\n" +
  "              } else if (constitution.reason === 'unauthorized') {\r\n" +
  "              this.onLog?.('debug', 'Constitution skipped: project root not authorized');\r\n" +
  "              }\r\n" +
  "            }\r\n";

const n2 = s.indexOf(old2);
console.log('idx2', n2);
if (n2 >= 0) {
  const newTail =
    "              this.onLog?.('warn', `Constitution at ${constitution.file} > 32 KB — refused (no silent context bloat)`);\r\n" +
    "              else if (constitution.reason === 'unauthorized') {\r\n" +
    "                this.onLog?.('debug', 'Constitution skipped: project root not authorized');\r\n" +
    "              }\r\n" +
    "            }\r\n" +
    "            if (text) {\r\n" +
    "              if (!firstContent.includes(CONSTITUTION_MARKER)) {\r\n" +
    "                ctx.prependToSystem(\r\n" +
    "                  `\\n\\n${CONSTITUTION_MARKER}\\n${text}\\n${CONSTITUTION_MARKER}\\n`,\r\n" +
    "                );\r\n" +
    "              }\r\n" +
    "            } else if (firstContent.includes(CONSTITUTION_MARKER)) {\r\n" +
    "              // Rule set removed / no longer resolvable — clear the block.\r\n" +
    "              ctx.replaceSystemByMarker(CONSTITUTION_MARKER, null);\r\n" +
    "            }\r\n" +
    "          } catch {";
  s = s.slice(0, n2) + newTail + s.slice(n2 + old2.length);
  fs.writeFileSync(p, s);
  console.log('replaced OK');
} else {
  // Try old2b variant (already-nested form)
  const m2 = s.indexOf(old2b);
  if (m2 >= 0) {
    console.log('using old2b variant');
    const newRaw =
      "              this.onLog?.('warn', `Constitution at ${constitution.file} > 32 KB — refused (no silent context bloat)`);\r\n" +
      "              } else if (constitution.reason === 'unauthorized') {\r\n" +
      "                this.onLog?.('debug', 'Constitution skipped: project root not authorized');\r\n" +
      "              }\r\n" +
      "            }\r\n" +
      "            if (text) {\r\n" +
      "              if (!firstContent.includes(CONSTITUTION_MARKER)) {\r\n" +
      "                ctx.prependToSystem(\r\n" +
      "                  `\\n\\n${CONSTITUTION_MARKER}\\n${text}\\n${CONSTITUTION_MARKER}\\n`,\r\n" +
      "                );\r\n" +
      "              }\r\n" +
      "            } else if (firstContent.includes(CONSTITUTION_MARKER)) {\r\n" +
      "              ctx.replaceSystemByMarker(CONSTITUTION_MARKER, null);\r\n" +
      "            }\r\n" +
      "          } catch {";
    s = s.slice(0, m2) + newRaw + s.slice(m2 + old2b.length);
    fs.writeFileSync(p, s);
    console.log('replaced OK (variant)');
  } else {
    console.log('tail pattern not found — file left modified, verify manually');
    fs.writeFileSync(p, s);
  }
}