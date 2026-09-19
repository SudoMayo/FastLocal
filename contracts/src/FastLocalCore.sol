// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title FastLocalCore
/// @notice Instant disruption cover for local train commuters.
///         Buy a pass for a station. If the oracle marks the station DISRUPTED,
///         an agent pushes a fixed payout. No claim needed.
contract FastLocalCore {
    enum Status { CLEAR, ALERT, DISRUPTED }
    enum Cause { NONE, RAIN_FLOOD, SIGNAL_FAILURE, POWER_FAILURE, TRACK_FAULT, OTHER }

    // Packs into one storage slot (8 + 3*64 + 8 + 8 = 216 bits).
    struct Policy {
        uint8 stationId;
        uint64 boughtAt;
        uint64 expiry;
        uint64 paidBlock;
        bool active;
        bool paid;
    }

    uint8 public constant STATION_COUNT = 6;
    uint64 public constant PASS_DURATION = 1 days;

    address public owner;
    address public oracle;
    mapping(address => bool) public isAgent;

    uint256 public basePremium = 0.001 ether;
    uint256 public payoutAmount = 0.03 ether;
    uint64 public waitingPeriod;
    bool public salesOpen = true;

    mapping(uint8 => Status) public stationStatus;
    mapping(uint8 => Cause) public stationCause;
    mapping(uint8 => uint64) public disruptedAtBlock;
    mapping(uint8 => address[]) public buyers;
    mapping(uint8 => mapping(address => bool)) public isBuyer; // keeps buyers[] unique
    mapping(address => Policy) public policies;

    uint256 private locked = 1;

    event PassBought(address indexed buyer, uint8 indexed stationId, uint256 premium, uint64 expiry);
    event StationUpdated(uint8 indexed stationId, Status status, Cause cause, uint256 blockNumber);
    event PayoutSent(address indexed buyer, uint8 indexed stationId, uint256 amount);
    event PayoutFailed(address indexed buyer, uint8 indexed stationId, uint256 amount);
    event AgentSet(address indexed agent, bool allowed);
    event OracleSet(address indexed oracle);
    event VaultFunded(address indexed from, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier onlyOracle() {
        require(msg.sender == oracle, "Not oracle");
        _;
    }

    modifier onlyAgent() {
        require(isAgent[msg.sender], "Not agent");
        _;
    }

    modifier nonReentrant() {
        require(locked == 1, "Reentrant");
        locked = 2;
        _;
        locked = 1;
    }

    modifier validStation(uint8 id) {
        require(id < STATION_COUNT, "Bad station");
        _;
    }

    constructor() {
        owner = msg.sender;
        oracle = msg.sender;
    }

    receive() external payable {
        emit VaultFunded(msg.sender, msg.value);
    }

    // ---------- Commuter ----------

    function premiumFor(uint8 id) public view validStation(id) returns (uint256) {
        Status s = stationStatus[id];
        require(s != Status.DISRUPTED, "Sales closed");
        return s == Status.ALERT ? basePremium * 2 : basePremium;
    }

    function buyPass(uint8 id) external payable nonReentrant validStation(id) {
        require(salesOpen, "Sales paused");
        require(msg.value == premiumFor(id), "Wrong premium");

        Policy storage p = policies[msg.sender];
        require(!(p.active && !p.paid && p.expiry > block.timestamp), "Active policy");

        uint64 nowTs = uint64(block.timestamp);
        uint64 expiry = nowTs + PASS_DURATION;
        policies[msg.sender] = Policy({
            stationId: id,
            boughtAt: nowTs,
            expiry: expiry,
            paidBlock: 0,
            active: true,
            paid: false
        });

        if (!isBuyer[id][msg.sender]) {
            isBuyer[id][msg.sender] = true;
            buyers[id].push(msg.sender);
        }

        emit PassBought(msg.sender, id, msg.value, expiry);
    }

    // ---------- Oracle ----------

    function setStation(uint8 id, Status status, Cause cause) external onlyOracle validStation(id) {
        if (status == Status.CLEAR) {
            cause = Cause.NONE;
        } else {
            require(cause != Cause.NONE, "Cause required");
        }
        // Keep the first disruption block so the speed proof stays honest.
        if (status == Status.DISRUPTED && stationStatus[id] != Status.DISRUPTED) {
            disruptedAtBlock[id] = uint64(block.number);
        }
        stationStatus[id] = status;
        stationCause[id] = cause;
        emit StationUpdated(id, status, cause, block.number);
    }

    // ---------- Agent ----------

    function isEligible(address buyer) public view returns (bool) {
        Policy memory p = policies[buyer];
        return p.active
            && !p.paid
            && p.expiry > block.timestamp
            && block.timestamp >= uint256(p.boughtAt) + waitingPeriod
            && stationStatus[p.stationId] == Status.DISRUPTED;
    }

    function payout(address buyer) external onlyAgent nonReentrant {
        require(isEligible(buyer), "Not eligible");
        uint256 amount = payoutAmount;
        require(address(this).balance >= amount, "Vault too low");

        Policy storage p = policies[buyer];
        p.paid = true;
        p.active = false;
        p.paidBlock = uint64(block.number);

        (bool ok,) = buyer.call{value: amount}("");
        require(ok, "Transfer failed");
        emit PayoutSent(buyer, p.stationId, amount);
    }

    /// Pays every eligible address, skips the rest. Safe to race with payout().
    function payoutBatch(address[] calldata list) external onlyAgent nonReentrant returns (uint256 paidCount) {
        uint256 amount = payoutAmount;
        for (uint256 i = 0; i < list.length; i++) {
            address buyer = list[i];
            if (!isEligible(buyer)) continue;
            if (address(this).balance < amount) break;

            Policy storage p = policies[buyer];
            Policy memory before = p;
            p.paid = true;
            p.active = false;
            p.paidBlock = uint64(block.number);

            // Gas cap so one hostile receiver cannot burn the whole batch.
            (bool ok,) = buyer.call{value: amount, gas: 50_000}("");
            if (ok) {
                paidCount++;
                emit PayoutSent(buyer, before.stationId, amount);
            } else {
                policies[buyer] = before;
                emit PayoutFailed(buyer, before.stationId, amount);
            }
        }
    }

    // ---------- Views ----------

    function getAllStatuses()
        external
        view
        returns (Status[STATION_COUNT] memory statuses, Cause[STATION_COUNT] memory causes)
    {
        for (uint8 i = 0; i < STATION_COUNT; i++) {
            statuses[i] = stationStatus[i];
            causes[i] = stationCause[i];
        }
    }

    function buyerCount(uint8 id) external view validStation(id) returns (uint256) {
        return buyers[id].length;
    }

    function getSnapshot(uint8 id, uint256 offset, uint256 limit)
        external
        view
        validStation(id)
        returns (address[] memory addrs, Policy[] memory pols)
    {
        address[] storage list = buyers[id];
        uint256 end = offset + limit;
        if (end > list.length) end = list.length;
        uint256 n = offset < end ? end - offset : 0;

        addrs = new address[](n);
        pols = new Policy[](n);
        for (uint256 i = 0; i < n; i++) {
            addrs[i] = list[offset + i];
            pols[i] = policies[addrs[i]];
        }
    }

    function vaultCoverage() external view returns (uint256) {
        return address(this).balance / payoutAmount;
    }

    // ---------- Owner ----------

    function setAgent(address agent, bool allowed) external onlyOwner {
        isAgent[agent] = allowed;
        emit AgentSet(agent, allowed);
    }

    function setOracle(address newOracle) external onlyOwner {
        require(newOracle != address(0), "Zero oracle");
        oracle = newOracle;
        emit OracleSet(newOracle);
    }

    function setPremium(uint256 newPremium) external onlyOwner {
        require(newPremium > 0, "Zero premium");
        basePremium = newPremium;
    }

    function setPayout(uint256 newPayout) external onlyOwner {
        require(newPayout > 0, "Zero payout");
        payoutAmount = newPayout;
    }

    function setSalesOpen(bool open) external onlyOwner {
        salesOpen = open;
    }

    function setWaitingPeriod(uint64 secondsToWait) external onlyOwner {
        waitingPeriod = secondsToWait;
    }

    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        (bool ok,) = owner.call{value: amount}("");
        require(ok, "Withdraw failed");
    }
}
