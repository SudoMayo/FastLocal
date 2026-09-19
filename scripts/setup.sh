#!/usr/bin/env bash
# One-time setup: creates the 4 wallets and fills contracts/.env and web/.env.local.
# Keys go only into gitignored files. Nothing secret is printed.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v cast >/dev/null || { echo "Foundry not found. Install: curl -L https://foundry.paradigm.xyz | bash && foundryup"; exit 1; }
command -v node >/dev/null || { echo "Node.js 20+ not found. Install it from https://nodejs.org"; exit 1; }
for f in .secrets/wallets.env contracts/.env web/.env.local; do
  [ -e "$f" ] && { echo "Setup already done ($f exists). Delete .secrets/, contracts/.env and web/.env.local to start over."; exit 1; }
done

umask 077
mkdir -p .secrets
new_wallet() {
  local out
  out=$(cast wallet new 2>&1) # cast prints keys to stderr; keep both streams out of the terminal
  echo "$1_ADDRESS=$(awk '/^Address:/{print $2}' <<<"$out")"
  echo "$1_PRIVATE_KEY=$(awk '/^Private key:/{print $3}' <<<"$out")"
}
{
  echo "# FastLocal wallets. NEVER COMMIT OR SHARE."
  for w in DEPLOYER RELAYER AGENT_WORKER AGENT_SERVER; do new_wallet "$w"; done
} > .secrets/wallets.env
# shellcheck disable=SC1091
source .secrets/wallets.env
PASSCODE=$(node -e "console.log(require('crypto').randomBytes(8).toString('hex'))")

cat > contracts/.env <<EOF
DEPLOYER_PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY
AGENT_WORKER_ADDRESS=$AGENT_WORKER_ADDRESS
AGENT_SERVER_ADDRESS=$AGENT_SERVER_ADDRESS
VAULT_FUND_MON=3
EOF

cat > web/.env.local <<EOF
# Client
NEXT_PUBLIC_CONTRACT_ADDRESS=
NEXT_PUBLIC_RPC_URL=https://testnet-rpc.monad.xyz
NEXT_PUBLIC_EXPLORER_URL=https://testnet.monadvision.com
NEXT_PUBLIC_CHAIN_ID=10143

# Server
RPC_URL=https://testnet-rpc.monad.xyz
ORACLE_PRIVATE_KEY=$DEPLOYER_PRIVATE_KEY
RELAYER_PRIVATE_KEY=$RELAYER_PRIVATE_KEY
AGENT_SERVER_PRIVATE_KEY=$AGENT_SERVER_PRIVATE_KEY
AGENT_WORKER_ADDRESS=$AGENT_WORKER_ADDRESS
ADMIN_PASSCODE=$PASSCODE
DRIP_AMOUNT_MON=0.065

# Worker (npm run agent)
AGENT_WORKER_PRIVATE_KEY=$AGENT_WORKER_PRIVATE_KEY
CONTRACT_ADDRESS=
EOF

echo "Created 4 wallets (keys saved in .secrets/wallets.env):"
echo "  DEPLOYER      $DEPLOYER_ADDRESS"
echo "  RELAYER       $RELAYER_ADDRESS"
echo "  AGENT_WORKER  $AGENT_WORKER_ADDRESS"
echo "  AGENT_SERVER  $AGENT_SERVER_ADDRESS"
echo
echo "Next: get about 25 testnet MON for DEPLOYER at https://faucet.monad.xyz, then run ./scripts/deploy-testnet.sh"
echo "Your operator passcode is in web/.env.local (ADMIN_PASSCODE)."
