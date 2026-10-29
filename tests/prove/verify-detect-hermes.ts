// Step A acceptance: the card detect would write must point at an .exe (not a .cmd).
import { detectAgents, defaultDetectContext } from '../../hub/adapters/detect.ts'

const detected = detectAgents(defaultDetectContext())
for (const d of detected) {
  const cmd = d.card.command
  const kind = d.card.kind
  const flag = kind === 'hermes' ? (cmd.toLowerCase().endsWith('.exe') ? 'PASS' : 'FAIL') : '    '
  console.log(`${flag}  ${d.card.agent_id.padEnd(15)} kind=${kind.padEnd(11)} command=${cmd}`)
}
const hermes = detected.find((d) => d.card.kind === 'hermes')
if (hermes) {
  const ok = hermes.card.command.toLowerCase().endsWith('.exe')
  console.log(`\nhermes command ends with .exe: ${ok}`)
  console.log(`is a .cmd (cmd.exe 8191-char limit): ${/\.(cmd|bat)$/i.test(hermes.card.command)}`)
  process.exit(ok ? 0 : 1)
}
console.log('\nhermes not detected on this machine')
process.exit(0)
