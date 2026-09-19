// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {FastLocalCore} from "../src/FastLocalCore.sol";

/// Deploys FastLocalCore, registers both agents, funds the vault.
/// Env: DEPLOYER_PRIVATE_KEY, AGENT_WORKER_ADDRESS, AGENT_SERVER_ADDRESS, VAULT_FUND_MON
contract Deploy is Script {
    function run() external returns (FastLocalCore core) {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address agentWorker = vm.envAddress("AGENT_WORKER_ADDRESS");
        address agentServer = vm.envAddress("AGENT_SERVER_ADDRESS");
        uint256 vaultFund = parseMon(vm.envOr("VAULT_FUND_MON", string("0")));

        vm.startBroadcast(deployerKey);
        core = new FastLocalCore();
        core.setAgent(agentWorker, true);
        core.setAgent(agentServer, true);
        if (vaultFund > 0) {
            (bool ok,) = address(core).call{value: vaultFund}("");
            require(ok, "Vault funding failed");
        }
        vm.stopBroadcast();

        console.log("FastLocalCore:", address(core));
        console.log("Deploy block:", block.number);
        console.log("Vault funded (wei):", vaultFund);
    }

    /// "3" -> 3e18, "0.5" -> 5e17. Up to 18 decimals.
    function parseMon(string memory s) internal pure returns (uint256 wei_) {
        bytes memory b = bytes(s);
        uint256 whole;
        uint256 frac;
        uint256 fracDigits;
        bool dot;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            if (c == ".") {
                require(!dot, "Bad VAULT_FUND_MON");
                dot = true;
                continue;
            }
            require(c >= "0" && c <= "9", "Bad VAULT_FUND_MON");
            uint256 d = uint8(c) - 48;
            if (dot) {
                require(fracDigits < 18, "Too many decimals");
                frac = frac * 10 + d;
                fracDigits++;
            } else {
                whole = whole * 10 + d;
            }
        }
        wei_ = whole * 1e18 + frac * 10 ** (18 - fracDigits);
    }
}
