# FastLocal: Claude Code context

Read docs/PRD.md before any work. It is the source of truth.

## Situation
Monad Blitz Mumbai V4. Code freeze 4:50 PM IST. Submission locks 5:45 PM.
Scored by rubric: working product, verified contract, hosted app, README a stranger
can follow. Reliability beats features.

## Rules
- Build only what the PRD lists. P0 first. P1 only when I say.
- Confirm every Monad value (RPC, chain id, explorer, verifier, verify command,
  gas rules, reserve balance rule) on https://docs.monad.xyz. If you cannot
  confirm it, stop and ask.
- Simple, readable code. Clear names. Short comments only.
- Never print or commit private keys. All .env files and .secrets/ are gitignored.
- Explicit gas limit on every write.
- Implement every row of the PRD edge-case table.
- Commit and push after each checkpoint.
- If a step fails twice, stop. Show the exact error and 2 options.
- Never state a performance number we did not measure.
- Never run mainnet transactions. Give me the commands.

## Ownership
- You own: contracts/, web/lib/, web/app/api/, web/scripts/, README.md.
- Teammate (Copilot) owns: web/components/ and styling in web/app/*/page.tsx.
- You may wire data into pages. Do not restyle components.

## Commands
contracts: forge build, forge test
web: npm run dev, npm run build, npm run agent, npm run seed
