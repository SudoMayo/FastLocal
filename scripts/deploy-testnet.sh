#!/usr/bin/env bash
# Deploys FastLocalCore to Monad Testnet, verifies it, funds the helper wallets,
# and writes the contract address into web/.env.local. Run ./scripts/setup.sh first.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -e .secrets/wallets.env ] || { echo "Run ./scripts/setup.sh first."; exit 1; }
set -a
# shellcheck disable=SC1091
source .secrets/wallets.env
# shellcheck disable=SC1091
source contracts/.env
set +a

RPC=https://testnet-rpc.monad.xyz
# Relayer sends value on every drip and must stay above Monad's 10 MON reserve.
RELAYER_FUND_MON=${RELAYER_FUND_MON:-14}
AGENT_WORKER_FUND_MON=${AGENT_WORKER_FUND_MON:-3}
AGENT_SERVER_FUND_MON=${AGENT_SERVER_FUND_MON:-1.5}

need=$(node -e "console.log(($VAULT_FUND_MON + $RELAYER_FUND_MON + $AGENT_WORKER_FUND_MON + $AGENT_SERVER_FUND_MON + 1).toFixed(2))")
have=$(cast balance "$DEPLOYER_ADDRESS" --ether --rpc-url "$RPC")
if node -e "process.exit(Number('$have') >= Number('$need') ? 1 : 0)"; then
  echo "DEPLOYER $DEPLOYER_ADDRESS has $have MON, needs about $need MON."
  echo "Get testnet MON at https://faucet.monad.xyz and run this again."
  exit 1
fi

echo "1/4 Deploying FastLocalCore..."
(cd contracts && forge script script/Deploy.s.sol:Deploy --rpc-url monad_testnet --broadcast --slow --gas-estimate-multiplier 130 >/dev/null)
ADDR=$(node -e "const r=require('./contracts/broadcast/Deploy.s.sol/10143/run-latest.json').receipts.find(x=>x.contractAddress);console.log(r.contractAddress)")
echo "    Contract: $ADDR"

echo "2/4 Verifying on MonadVision (Sourcify)..."
(cd contracts && forge verify-contract "$ADDR" src/FastLocalCore.sol:FastLocalCore --chain 10143 \
  --verifier sourcify --verifier-url https://sourcify-api-monad.blockvision.org/ >/dev/null 2>&1) \
  && echo "    Verified" || echo "    Verification failed; retry later with the forge verify-contract command in the README."

echo "3/4 Funding relayer and agents..."
for pair in "$RELAYER_ADDRESS:$RELAYER_FUND_MON" "$AGENT_WORKER_ADDRESS:$AGENT_WORKER_FUND_MON" "$AGENT_SERVER_ADDRESS:$AGENT_SERVER_FUND_MON"; do
  cast send "${pair%%:*}" --value "${pair##*:}ether" --gas-limit 21000 \
    --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" >/dev/null
  echo "    ${pair%%:*} +${pair##*:} MON"
done

echo "4/4 Writing the contract address into web/.env.local..."
node -e "
const fs=require('fs');const p='web/.env.local';
let s=fs.readFileSync(p,'utf8');
s=s.replace(/^NEXT_PUBLIC_CONTRACT_ADDRESS=.*$/m,'NEXT_PUBLIC_CONTRACT_ADDRESS=$ADDR').replace(/^CONTRACT_ADDRESS=.*$/m,'CONTRACT_ADDRESS=$ADDR');
fs.writeFileSync(p,s);"

echo
echo "Done. Contract: https://testnet.monadvision.com/address/$ADDR"
echo "Next: cd web && npm install && npm run dev   (and in a second terminal: cd web && npm run agent)"
