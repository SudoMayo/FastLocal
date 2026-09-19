// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {FastLocalCore} from "../src/FastLocalCore.sol";

/// Rejects any MON sent to it.
contract RevertingReceiver {
    function buy(FastLocalCore core, uint8 id) external payable {
        core.buyPass{value: msg.value}(id);
    }

    receive() external payable {
        revert("no thanks");
    }
}

contract FastLocalCoreTest is Test {
    FastLocalCore core;
    address agent = makeAddr("agent");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");

    uint8 constant DADAR = 1;
    uint8 constant KURLA = 2;
    uint256 constant PREMIUM = 0.001 ether;
    uint256 constant PAYOUT = 0.03 ether;

    receive() external payable {} // owner receives withdraw()

    function setUp() public {
        core = new FastLocalCore();
        core.setAgent(agent, true);
        (bool ok,) = address(core).call{value: 3 ether}("");
        require(ok);
        vm.deal(alice, 1 ether);
        vm.deal(bob, 1 ether);
        vm.deal(carol, 1 ether);
    }

    function _buy(address who, uint8 id) internal {
        uint256 price = core.premiumFor(id);
        vm.prank(who);
        core.buyPass{value: price}(id);
    }

    function _disrupt(uint8 id) internal {
        core.setStation(id, FastLocalCore.Status.DISRUPTED, FastLocalCore.Cause.RAIN_FLOOD);
    }

    function _policy(address who) internal view returns (FastLocalCore.Policy memory p) {
        (p.stationId, p.boughtAt, p.expiry, p.paidBlock, p.active, p.paid) = core.policies(who);
    }

    // ---------- buyPass ----------

    function test_BuyOk() public {
        _buy(alice, DADAR);
        FastLocalCore.Policy memory p = _policy(alice);
        assertEq(p.stationId, DADAR);
        assertTrue(p.active);
        assertFalse(p.paid);
        assertEq(p.expiry, block.timestamp + 1 days);
        assertEq(core.buyerCount(DADAR), 1);
        assertEq(address(core).balance, 3 ether + PREMIUM);
    }

    function test_WrongPremiumFails() public {
        vm.prank(alice);
        vm.expectRevert("Wrong premium");
        core.buyPass{value: PREMIUM - 1}(DADAR);
    }

    function test_AlertDoublesPrice() public {
        core.setStation(DADAR, FastLocalCore.Status.ALERT, FastLocalCore.Cause.RAIN_FLOOD);
        assertEq(core.premiumFor(DADAR), 2 * PREMIUM);

        vm.prank(alice);
        vm.expectRevert("Wrong premium");
        core.buyPass{value: PREMIUM}(DADAR);

        vm.prank(alice);
        core.buyPass{value: 2 * PREMIUM}(DADAR);
        assertTrue(_policy(alice).active);
    }

    function test_BuyFailsWhenDisrupted() public {
        _disrupt(DADAR);
        vm.expectRevert("Sales closed");
        core.premiumFor(DADAR);

        vm.prank(alice);
        vm.expectRevert("Sales closed");
        core.buyPass{value: PREMIUM}(DADAR);
    }

    function test_BuyFailsWhenSalesClosed() public {
        core.setSalesOpen(false);
        vm.prank(alice);
        vm.expectRevert("Sales paused");
        core.buyPass{value: PREMIUM}(DADAR);
    }

    function test_BuyTwiceFails() public {
        _buy(alice, DADAR);
        vm.prank(alice);
        vm.expectRevert("Active policy");
        core.buyPass{value: PREMIUM}(DADAR);
    }

    function test_BadStationFails() public {
        vm.prank(alice);
        vm.expectRevert("Bad station");
        core.buyPass{value: PREMIUM}(6);
    }

    function test_BuyAgainAfterExpiry() public {
        _buy(alice, DADAR);
        vm.warp(block.timestamp + 1 days);
        _buy(alice, DADAR);
        assertEq(core.buyerCount(DADAR), 1); // buyers list stays unique
    }

    function test_PaidUserCanBuyAgain() public {
        _buy(alice, DADAR);
        _disrupt(DADAR);
        vm.prank(agent);
        core.payout(alice);
        core.setStation(DADAR, FastLocalCore.Status.CLEAR, FastLocalCore.Cause.NONE);
        _buy(alice, DADAR);
        assertTrue(_policy(alice).active);
        assertFalse(_policy(alice).paid);
    }

    // ---------- setStation ----------

    function test_SetStationCauseRules() public {
        // CLEAR forces NONE
        core.setStation(DADAR, FastLocalCore.Status.CLEAR, FastLocalCore.Cause.SIGNAL_FAILURE);
        assertEq(uint8(core.stationCause(DADAR)), uint8(FastLocalCore.Cause.NONE));

        // ALERT and DISRUPTED need a cause
        vm.expectRevert("Cause required");
        core.setStation(DADAR, FastLocalCore.Status.ALERT, FastLocalCore.Cause.NONE);
        vm.expectRevert("Cause required");
        core.setStation(DADAR, FastLocalCore.Status.DISRUPTED, FastLocalCore.Cause.NONE);

        core.setStation(DADAR, FastLocalCore.Status.DISRUPTED, FastLocalCore.Cause.TRACK_FAULT);
        assertEq(uint8(core.stationStatus(DADAR)), uint8(FastLocalCore.Status.DISRUPTED));
        assertEq(uint8(core.stationCause(DADAR)), uint8(FastLocalCore.Cause.TRACK_FAULT));
    }

    function test_SetStationOnlyOracle() public {
        vm.prank(alice);
        vm.expectRevert("Not oracle");
        _disrupt(DADAR);
    }

    function test_DisruptedAtBlockSet() public {
        vm.roll(1234);
        _disrupt(DADAR);
        assertEq(core.disruptedAtBlock(DADAR), 1234);

        // Changing the cause while disrupted keeps the first block.
        vm.roll(1300);
        core.setStation(DADAR, FastLocalCore.Status.DISRUPTED, FastLocalCore.Cause.POWER_FAILURE);
        assertEq(core.disruptedAtBlock(DADAR), 1234);
    }

    // ---------- payout ----------

    function test_PayoutOk() public {
        _buy(alice, DADAR);
        vm.roll(500);
        _disrupt(DADAR);
        uint256 before = alice.balance;

        vm.prank(agent);
        core.payout(alice);

        assertEq(alice.balance, before + PAYOUT);
        FastLocalCore.Policy memory p = _policy(alice);
        assertTrue(p.paid);
        assertFalse(p.active);
        assertEq(p.paidBlock, 500);
    }

    function test_PayoutFailsWhenNotDisrupted() public {
        _buy(alice, DADAR);
        core.setStation(DADAR, FastLocalCore.Status.ALERT, FastLocalCore.Cause.RAIN_FLOOD);
        vm.prank(agent);
        vm.expectRevert("Not eligible");
        core.payout(alice);
    }

    function test_DisruptionElsewhereNotPaid() public {
        _buy(alice, DADAR);
        _disrupt(KURLA);
        assertFalse(core.isEligible(alice));
    }

    function test_DoublePayoutFails() public {
        _buy(alice, DADAR);
        _disrupt(DADAR);
        vm.startPrank(agent);
        core.payout(alice);
        vm.expectRevert("Not eligible");
        core.payout(alice);
        vm.stopPrank();
    }

    function test_NonAgentFails() public {
        _buy(alice, DADAR);
        _disrupt(DADAR);
        vm.prank(bob);
        vm.expectRevert("Not agent");
        core.payout(alice);

        address[] memory list = new address[](1);
        list[0] = alice;
        vm.prank(bob);
        vm.expectRevert("Not agent");
        core.payoutBatch(list);
    }

    function test_ExpiredNotPaid() public {
        _buy(alice, DADAR);
        vm.warp(block.timestamp + 1 days);
        _disrupt(DADAR);
        vm.prank(agent);
        vm.expectRevert("Not eligible");
        core.payout(alice);
    }

    function test_WaitingPeriodEnforced() public {
        core.setWaitingPeriod(600);
        _buy(alice, DADAR);
        _disrupt(DADAR);

        vm.prank(agent);
        vm.expectRevert("Not eligible");
        core.payout(alice);

        vm.warp(block.timestamp + 600);
        vm.prank(agent);
        core.payout(alice);
        assertTrue(_policy(alice).paid);
    }

    function test_VaultTooLow() public {
        core.withdraw(address(core).balance);
        _buy(alice, DADAR);
        _disrupt(DADAR);
        vm.prank(agent);
        vm.expectRevert("Vault too low");
        core.payout(alice);
    }

    // ---------- payoutBatch ----------

    function test_BatchSkipsIneligibleAndPaysEligible() public {
        _buy(alice, DADAR);
        _buy(bob, DADAR);
        _buy(carol, KURLA); // other station: not eligible
        _disrupt(DADAR);

        vm.prank(agent);
        core.payout(alice); // already paid: skipped

        address[] memory list = new address[](4);
        list[0] = alice;
        list[1] = bob;
        list[2] = carol;
        list[3] = makeAddr("nobody");

        uint256 bobBefore = bob.balance;
        vm.prank(agent);
        uint256 paid = core.payoutBatch(list);

        assertEq(paid, 1);
        assertEq(bob.balance, bobBefore + PAYOUT);
        assertTrue(_policy(bob).paid);
        assertFalse(_policy(carol).paid);
        assertTrue(_policy(carol).active);
    }

    function test_BatchRestoresPolicyWhenRecipientRejects() public {
        RevertingReceiver bad = new RevertingReceiver();
        bad.buy{value: PREMIUM}(core, DADAR);
        _buy(alice, DADAR);
        _disrupt(DADAR);

        address[] memory list = new address[](2);
        list[0] = address(bad);
        list[1] = alice;

        vm.expectEmit(true, true, false, true);
        emit FastLocalCore.PayoutFailed(address(bad), DADAR, PAYOUT);
        vm.prank(agent);
        uint256 paid = core.payoutBatch(list);

        assertEq(paid, 1);
        FastLocalCore.Policy memory p = _policy(address(bad));
        assertTrue(p.active);
        assertFalse(p.paid);
        assertEq(p.paidBlock, 0);
        assertTrue(_policy(alice).paid);
    }

    function test_BatchStopsWhenVaultEmpty() public {
        core.withdraw(address(core).balance);
        (bool ok,) = address(core).call{value: PAYOUT}("");
        require(ok);
        _buy(alice, DADAR);
        _buy(bob, DADAR);
        _disrupt(DADAR);
        // Vault now holds PAYOUT + 2 premiums: enough for one payout only.
        address[] memory list = new address[](2);
        list[0] = alice;
        list[1] = bob;
        vm.prank(agent);
        assertEq(core.payoutBatch(list), 1);
        assertTrue(core.isEligible(bob)); // next cycle can pay after funding
    }

    // ---------- views ----------

    function test_GetSnapshotPagination() public {
        for (uint256 i = 0; i < 5; i++) {
            address u = address(uint160(0x1000 + i));
            vm.deal(u, 1 ether);
            _buy(u, DADAR);
        }
        (address[] memory a, FastLocalCore.Policy[] memory p) = core.getSnapshot(DADAR, 0, 2);
        assertEq(a.length, 2);
        assertEq(a[0], address(uint160(0x1000)));
        assertEq(p[1].stationId, DADAR);

        (a,) = core.getSnapshot(DADAR, 4, 10);
        assertEq(a.length, 1);
        assertEq(a[0], address(uint160(0x1004)));

        (a,) = core.getSnapshot(DADAR, 9, 10);
        assertEq(a.length, 0);
    }

    function test_GetAllStatuses() public {
        _disrupt(DADAR);
        core.setStation(KURLA, FastLocalCore.Status.ALERT, FastLocalCore.Cause.SIGNAL_FAILURE);
        (FastLocalCore.Status[6] memory s, FastLocalCore.Cause[6] memory c) = core.getAllStatuses();
        assertEq(uint8(s[DADAR]), uint8(FastLocalCore.Status.DISRUPTED));
        assertEq(uint8(c[DADAR]), uint8(FastLocalCore.Cause.RAIN_FLOOD));
        assertEq(uint8(s[KURLA]), uint8(FastLocalCore.Status.ALERT));
        assertEq(uint8(c[KURLA]), uint8(FastLocalCore.Cause.SIGNAL_FAILURE));
        assertEq(uint8(s[0]), uint8(FastLocalCore.Status.CLEAR));
    }

    function test_VaultCoverage() public {
        assertEq(core.vaultCoverage(), 100); // 3 / 0.03
        core.setPayout(1 ether);
        assertEq(core.vaultCoverage(), 3);
    }

    function test_OwnerOnly() public {
        vm.startPrank(alice);
        vm.expectRevert("Not owner");
        core.setAgent(alice, true);
        vm.expectRevert("Not owner");
        core.withdraw(1);
        vm.expectRevert("Not owner");
        core.setSalesOpen(false);
        vm.stopPrank();
    }
}
