/**
 *  Wallet Worker
 *
 *  Every 90 seconds, request info for all addresses that haven't been updated in the last 60s?
 */

importScripts('../thirdparty.js');
importScripts('../request.js');

importScripts('../network.js');
importScripts('../jaxx_main/jaxx_constants.js');
importScripts('../wallet/hdwallet_helper.js');
importScripts('../wallet/hdwallet_pouch.js');

importScripts("../relays/relay_task.js");

importScripts("../relays/blockchain_relay.js");
importScripts("../relays/blockcypher_relay.js");
importScripts("../relays/blockexplorer_relay.js");
importScripts("../relays/blockr_relay.js");
importScripts("../chainrelay.js");

var doDebug = true;

function log() {
    if (doDebug === false) {
        return;
    }

    var args = [].slice.call(arguments);
    args.unshift('WorkerLog:');
//    console.log(args);
    postMessage({action: 'log', content: args});
}

//@note: @here: for android.
if (typeof(console) === 'undefined' || console === null) {
    console = {};
    console.log = function() {};
}

var HDWalletWorkerManager = function() {
    this._coinType = -1;
    this._coinWorkerImpl = null;

    this._NETWORK = null;

    this._receiveNode = null;
    this._changeNode = null;

    this._lastReceiveIndex = -1;
    this._currentReceiveAddress = null;

    this._lastChangeIndex = -1;
    this._currentChangeAddress = null;

    this._addressMap = {};

    this._transactions = {};

    this._watcherQueue = [];

    this._usesWSS = false;
    this._watcherWebSocket = null;

    this._hasForcedRecheck = false;

    this._relayManager = null;
}

HDWalletWorkerManager.getDefaultTransactionRefreshTime = function() {
    return 60000;
}

HDWalletWorkerManager.prototype.initialize = function(coinType, testNet) {
    this._coinType = coinType;
    this._TESTNET = testNet;

    var self = this;

    if (this._coinType === COIN_BITCOIN) {
        log("[ HDWalletWorkerManager ] :: setup relay manager :: " + this._coinType);

        this._relayManager = new BitcoinRelays();
    }

    if (this._relayManager !== null) {
        this._relayManager.initialize();
        this._relayManager.setup(function(resultParams) {
            self.finishInitialization();
            postMessage({action: 'didInitialize', content: {}});

            log("[ HDWalletWorkerManager ] :: RelayTests :: fetchBlockHeights :: " + JSON.stringify(resultParams));
        }); // Setup the relays (Stored in a global so that instance data is not discarded.)
    } else {
        this.finishInitialization();
        postMessage({action: 'didInitialize', content: {}});
    }
}

HDWalletWorkerManager.prototype.finishInitialization = function() {
    if (this._coinType === COIN_BITCOIN) {
        importScripts('../wallet/hdwallet_worker_impl_bitcoin.js');
        importScripts('../wallet/hdwallet_pouch_impl_bitcoin.js');
        this._coinWorkerImpl = new HDWalletWorkerBitcoin();

        if (this._TESTNET) {
            this._NETWORK = thirdparty.bitcoin.networks.testnet;
            this._STATIC_RELAY_URL = 'https://tbtc.blockr.io';
        }
    } else if (this._coinType === COIN_ETHEREUM) {
        importScripts('../wallet/hdwallet_worker_impl_ethereum.js');
        importScripts('../wallet/hdwallet_pouch_impl_ethereum.js');
        this._coinWorkerImpl = new HDWalletWorkerEthereum();
    } else if (this._coinType === COIN_DASH) {
        importScripts('../wallet/hdwallet_worker_impl_dash.js');
        importScripts('../wallet/hdwallet_pouch_impl_dash.js');
//        this._NETWORK = HDWalletPouchDash.networkDefinitionTestNet;
        this._NETWORK = HDWalletPouchDash.networkDefinitionMainNet;
        this._coinWorkerImpl = new HDWalletWorkerDash();
    }

    log("[ HDWalletWorkerManager ] :: init :: " + this._coinType);

    this._coinWorkerImpl.initialize(this);

    var socketEntryPoint = this._TESTNET ? "test3": "main"; //Switch according to network
    this._blockCypherToken = "443eb2360338caf91c041ddd1464ee86" ; //Current token
    var socketUri = "";

    if (this._coinType === COIN_BITCOIN) {
        this._STATIC_RELAY_URL = 'https://btc.blockr.io';
        this._GATHER_TX = "/api/v1/address/txs/";
        this._GATHER_TX_APPEND = "";

        this._GATHER_UNCONFIRMED_TX = "/api/v1/address/unconfirmed/";

        this._MULTI_BALANCE = "";
        this._MULTI_BALANCE_APPEND = "";

        socketUri = "wss://socket.blockcypher.com/v1/btc/" + socketEntryPoint;
    } else if (this._coinType === COIN_ETHEREUM) {
        this._STATIC_RELAY_URL = "https://api.etherscan.io";
        this._GATHER_TX = "/api?module=account&action=txlist&address=";
        this._GATHER_TX_APPEND = "&sort=asc&apikey=" + HDWalletHelper.jaxxEtherscanAPIKEY;

        this._GATHER_UNCONFIRMED_TX = "";

        this._MULTI_BALANCE = "/api?module=account&action=balancemulti&address=";
        this._MULTI_BALANCE_APPEND = "&tag=latest&apikey=" + HDWalletHelper.jaxxEtherscanAPIKEY;

        socketUri = "";// "wss://api.ether.fund";
    } else if (this._coinType === COIN_DASH) {

        if (this.TESTNET) {
            this._STATIC_RELAY_URL = "http://jaxx-test.dash.org:3001/insight-api-dash";
        } else {
            this._STATIC_RELAY_URL = "http://api.jaxx.io:2052/insight-api-dash";
        }

        this._GATHER_TX = "/addrs/";
        this._GATHER_TX_APPEND = "/txs?group=1";

        this._GATHER_UNCONFIRMED_TX = "";

        this._MULTI_BALANCE = "";
        this._MULTI_BALANCE_APPEND = "";

        var socketUri = "";
    }

    var self = this;

    if (socketUri !== "") {
        this._usesWSS = true;
        this._watcherWebSocket = new WebSocket(socketUri);


        this._watcherWebSocket.onopen = function() {

            setInterval(function(){
                hdWalletWorkerManager._sendPing();
                //Will reply with pong
            }, 18000); //send a ping every 20 seconds more or less to avoid getting disconnected

            // We set the watcherQueue to null to indicate we are connected
            var watcherQueue = self._watcherQueue;
            self._watcherQueue = null;

            for (var i = 0; i < watcherQueue.length; i++) {
                self._watchAddress(watcherQueue[i]);
            }
        };


        this._watcherWebSocket.onmessage = function(event) {
            if (!event || !event.data) {
                return;
            }

            var data = JSON.parse(event.data);
            //            log("message from socket : "+ JSON.stringify(data));

            if(data.block_height == -1){ //tx not included in any block. schedule a refresh of tx in 10 seconds
                setTimeout(function () {
                    hdWalletWorkerManager.checkTransactions(0);
                }, 12000);
            }

            /*
        if (data.payload && data.payload.transaction_hash) {
            // Retry up to 10 times, with "exponential back-off" (not true exponential back-off)
            (function(txid) {

                var startTime = (new Date()).getTime();
                var retry = 0;
                var lookupTransaction = function() {

                    self._lookupBitcoinTransactions([txid], function (updated) {
                        if (!updated[txid] && retry < 10) {

                            timeout = 1.5 + Math.pow(1.4, retry++);
                            setTimeout(lookupTransaction, timeout * 1000);
                        }
                    });
                }

                setTimeout(lookupTransaction, 0);
            })(data.payload.transaction_hash);
        }
        */
        };

        // @TODO: onerror, re-connect
        this._watcherWebSocket.onerror = function(event) {
            log("watcher :: " + this._coinType + " :: error :: " + JSON.stringify(event));
        }
    }
}

HDWalletWorkerManager.prototype.shutDown = function() {
    if (this._watcherWebSocket !== null) {
        if (this._watcherWebSocket.readyState !== WebSocket.CLOSING && this._watcherWebSocket.readyState !== WebSocket.CLOSED) {
            this._watcherWebSocket.onclose = function() {};
            this._watcherWebSocket.close();
        }
    }

    close();
}

HDWalletWorkerManager.prototype._sendPing = function() {
    this._watcherWebSocket.send("{ \"event\": \"ping\" }");
}


HDWalletWorkerManager.prototype._watchAddress = function(address) {
    if (this._usesWSS) {
        if (this._watcherQueue !== null) {

            this._watcherQueue.push(address);

        } else {
            this._watcherWebSocket.send("{ \"event\": \"tx-confirmation\" , \"address\" : \"" + address + "\" ,\"token\": \"" + this._blockCypherToken + "\" }");
        }
    } else {

    }
}

HDWalletWorkerManager.prototype.setExtendedPublicKeys = function(receivePublicKey, changePublicKey) {
    log(this._coinType + " :: this._NETWORK :: " + this._NETWORK);
    this._receiveNode = thirdparty.bitcoin.HDNode.fromBase58(receivePublicKey, this._NETWORK);
    this._changeNode = thirdparty.bitcoin.HDNode.fromBase58(changePublicKey, this._NETWORK);

    var self = this;
    setTimeout(function() {
        self.checkTransactions(0);
    }, 500);
}

HDWalletWorkerManager.prototype.update = function(forcePouchRecheck) {
//    log("watcher :: " + this._coinType + " :: update :: " + this._transactions.length);
    var updates = {
        transactions: this._transactions,
        workerCacheAddressMap: this._addressMap,
    }

    if (!this._currentReceiveAddress) {
        this._currentReceiveAddress = HDWalletPouch.getCoinAddress(this._coinType, this._receiveNode.derive(this._lastReceiveIndex + 1)).toString();

        updates.currentReceiveAddress = this._currentReceiveAddress;

        if (this._coinType === COIN_BITCOIN) {
            updates.smallQrCode = "data:image/png;base64," + thirdparty.qrImage.imageSync("bitcoin:" + this._currentReceiveAddress, {type: "png", ec_level: "H", size: 3, margin: 1}).toString('base64');
            updates.largeQrCode = "data:image/png;base64," + thirdparty.qrImage.imageSync("bitcoin:" + this._currentReceiveAddress, {type: "png", ec_level: "H", size: 7, margin: 4}).toString('base64');
        } else if (this._coinType === COIN_ETHEREUM) {
            //@note: given the ICAP library issue and the fact that this is effectively an isolated "thread", ethereum can regenerate its QR codes later on.
        }
    }

    if (!this._currentChangeAddress) {
        this._currentChangeAddress = HDWalletPouch.getCoinAddress(this._coinType, this._changeNode.derive(this._lastChangeIndex + 1)).toString();
        updates.currentChangeIndex = this._lastChangeIndex + 1;
        updates.currentChangeAddress = this._currentChangeAddress;
    }

    if (typeof(forcePouchRecheck) !== 'undefined' && forcePouchRecheck !== null) {
        updates.forceRecheck = true;
    }

    postMessage({action: 'update', content: updates});
}

HDWalletWorkerManager.prototype.getAddressInfoLastUsedAndHighestDict = function() {
    var lastUsedReceiveIndex = -1, lastUsedChangeIndex = -1;
    var highestReceiveIndex = -1, highestChangeIndex = -1;
    //    if (this._coinType === COIN_ETHEREUM) {
    //        log("watcher :: " + this._coinType + " :: Object.keys(this._addressMap).length :: " + Object.keys(this._addressMap).length);
    //    }

    for (var address in this._addressMap) {
        var addressInfo = this._addressMap[address];

        // Track the highest index we've used
        if (addressInfo.used) {
            if (this._coinType === COIN_ETHEREUM) {
                //                if (!addressInfo.internal) {
                //                    log("watcher :: " + this._coinType + " :: address used :: " + address + " :: " + JSON.stringify(addressInfo));
                //                }
            }
            if (addressInfo.internal && addressInfo.index > lastUsedChangeIndex) {
                lastUsedChangeIndex = addressInfo.index;
                if (lastUsedChangeIndex > this._lastChangeIndex) {
                    this._lastChangeIndex = lastUsedChangeIndex;
                    this._currentChangeAddress = null;
                }

            } else if (!addressInfo.internal && addressInfo.index > lastUsedReceiveIndex) {
                lastUsedReceiveIndex = addressInfo.index;
                if (lastUsedReceiveIndex > this._lastReceiveIndex) {
                    this._lastReceiveIndex = lastUsedReceiveIndex;
                    this._currentReceiveAddress = null;
                }
            }
        }

        //@note:@here:@bug: I'm not sure the logic here is sound..

        // Track the highest address we've looked up so far (need to cover the gap)
        if (addressInfo.internal && addressInfo.index > highestChangeIndex) {
            highestChangeIndex = addressInfo.index;

        } else if (!addressInfo.internal && addressInfo.index > highestReceiveIndex) {
            highestReceiveIndex = addressInfo.index;
        }
    }

    return {lastUsedReceiveIndex: lastUsedReceiveIndex,
            lastUsedChangeIndex: lastUsedChangeIndex,
            highestReceiveIndex: highestReceiveIndex,
            highestChangeIndex: highestChangeIndex};
}

HDWalletWorkerManager.prototype.checkTransactions = function(addressesOrMinimumAge) {
    if (this._coinType === COIN_DASH) {
//        console.log("dash :: checkTransactions")
    }
//        if (this._coinType === COIN_ETHEREUM) {
//        log("checkTransactions")
//    }
//    if (this._coinType === COIN_ETHEREUM) {
//        log("watcher :: " + this._coinType + " :: check transactions :: " + addressesOrMinimumAge);
//    }

    //    log('Check Transactions: ' + addressesOrMinimumAge);
    var minimumAge = null;
    var addresses = [];
    if (typeof(addressesOrMinimumAge) === 'number') {
        minimumAge = addressesOrMinimumAge;
    } else {
        addresses = addressesOrMinimumAge;
    }

    // Can't do anything until we have the change and receive nodes
    if (!this._changeNode || !this._receiveNode) {
        log("watcher :: " + this._coinType + " :: checkTransactions :: nodes required");
        return;
    }

    var lastAndHighestDict = this.getAddressInfoLastUsedAndHighestDict();


//    if (this._coinType === COIN_ETHEREUM) {
//        log("watcher :: " + this._coinType + " :: address used :: " + JSON.stringify(addressInfo));
//    }


    var neededGenerate = false;

    // Now see if we need to generate another receive address
    if (lastAndHighestDict.lastUsedReceiveIndex + 20 > lastAndHighestDict.highestReceiveIndex) {
        var index = lastAndHighestDict.highestReceiveIndex + 1;
        var address = HDWalletPouch.getCoinAddress(this._coinType, this._receiveNode.derive(index)).toString();

//        if (this._coinType === COIN_ETHEREUM) {
//            log("watcher :: " + this._coinType + " :: address :: " + address + " :: index :: " + index + " :: receiveNode :: " +  this._receiveNode.derive(index) + " :: lastUsedReceiveIndex :: " + lastUsedReceiveIndex + " :: highestReceiveIndex :: " + highestReceiveIndex);
//        }

        this._addressMap[address] = {index: index, internal: 0, updatedTimestamp: 0, accountBalance: 0, accountTXProcessed: {}, nonce: 0, isTheDAOAssociated: false};
        this._watchAddress(address);

        neededGenerate = true;
    }

    // Now see if we need to generate another change address
    if (lastAndHighestDict.lastUsedChangeIndex + 20 > lastAndHighestDict.highestChangeIndex) {
        var index = lastAndHighestDict.highestChangeIndex + 1;
        var address = HDWalletPouch.getCoinAddress(this._coinType, this._changeNode.derive(index)).toString();
//        if (this._coinType === COIN_ETHEREUM) {
//            log("watcher :: " + this._coinType + " :: address :: " + address +  " :: index :: " + index + " :: changeNode :: " +  this._changeNode.derive(index) + " :: lastUsedChangeIndex :: " + lastUsedChangeIndex + " :: highestChangeIndex :: " + highestChangeIndex);
//        }
        this._addressMap[address] = {index: index, internal: 1, updatedTimestamp: 0, accountBalance: 0, accountTXProcessed: {}, nonce: 0, isTheDAOAssociated: false};
        this._watchAddress(address);

        neededGenerate = true;
    }

    // If we had to generate an address, reschedule in the near future generating some more
    if (neededGenerate) {
//        if (hdWalletWorkerManager._coinType === COIN_ETHEREUM) {
//            log("ethereum :: set timeout");
//        }
        setTimeout(function() {
//            if (hdWalletWorkerManager._coinType === COIN_ETHEREUM) {
//                log("ethereum :: updating");
//            }
            hdWalletWorkerManager.checkTransactions(HDWalletWorkerManager.getDefaultTransactionRefreshTime());
        }, 500);
    } else {
        this._performRecheckIfNecessary();
    }

    var now = (new Date()).getTime();

    // Find all addresses that have not been updated since our minimum age
    if (minimumAge !== null) {
        for (var address in this._addressMap) {
            var addressInfo = this._addressMap[address];
            if (now - addressInfo.updatedTimestamp < minimumAge * 1000) {
                continue;
            }
            addresses.push(address);
        }
    }

    //    if (this._coinType === COIN_ETHEREUM) {
    //        log("watcher :: " + this._coinType + " :: addresses :: " + addresses.length);
    //        return;
    //    }
    //
    if (this._coinType === COIN_DASH) {
//        log("dash :: addresses :: " + JSON.stringify(addresses));
    }

    this._batchScanBlockchain(addresses);
}

HDWalletWorkerManager.prototype._performRecheckIfNecessary = function() {
    if (this._hasForcedRecheck === false) {
        this._hasForcedRecheck = true;

        this._coinWorkerImpl.performRecheck();
    }
}

HDWalletWorkerManager.prototype._manuallyAddAddress = function(address) {
    var addressInfo = this._addressMap[address];

    if (typeof(addressInfo) === 'undefined' || addressInfo === null) {
        this._addressMap[address] = {index: index, internal: 1, updatedTimestamp: 0, accountBalance: 0, accountTXProcessed: {}, nonce: 0};
        this._watchAddress(address);
    }

    this._batchScanBlockchain([address]);
}

HDWalletWorkerManager.prototype._batchScanBlockchain = function(addresses) {
    var self = this;

    if (this._coinType === COIN_DASH) {
//        console.log("dash :: batchScanBlockchain :: addresses :: " + addresses);
    }
    //@note: @todo: @here: get the batch size from the relay directly.
    // Create batches of addresses to send to the blockr.io API
    var BATCH_SIZE = 1;

    //@note: bitcoin REST api supports a batch return.
    if (this._coinType === COIN_BITCOIN) {
        BATCH_SIZE = 10;
        //        console.log("tx checking for :: " + addresses.length);
    } else if (this._coinType === COIN_ETHEREUM) {
        BATCH_SIZE = 1;
    } else if (this._coinType === COIN_DASH) {
        BATCH_SIZE = 20;
    }

    //@note:@here:@todo: especially with the ethereum side, we'll probably have to throttle the download limit.

    var batch = [];
    while (addresses.length) {
        batch.push(addresses.shift());
        if (batch.length === BATCH_SIZE || addresses.length === 0) {

            // Request the transactions and utxo for this batch
            var addressParam = batch.join(',');

            //            if (this._coinType === COIN_ETHEREUM) {
            //                log("ethereum :: requesting :: " + addressParam);
            //            }
            //
            var requestURL = this._STATIC_RELAY_URL + this._GATHER_TX + addressParam + this._GATHER_TX_APPEND;

            if (this._coinType === COIN_DASH) {
//                console.log("dash :: requestURL :: " + requestURL);
            }

            RequestSerializer.getJSON(requestURL, function(data, success, passthroughParam) {
                if (this._coinType === COIN_DASH) {
//                    console.log("dash :: requestURL :: completed");
                }

                self._populateHistory(data, passthroughParam);
            }, null, addressParam);

            if (this._GATHER_UNCONFIRMED_TX !== "") {
                RequestSerializer.getJSON(this._STATIC_RELAY_URL + this._GATHER_UNCONFIRMED_TX + addressParam, function(data, success, passthroughParam) {
                    self._populateHistory(data, passthroughParam);
                }, null, addressParam);
            }

            // Clear the batch
            batch = [];
        }
    }
}

HDWalletWorkerManager.prototype.updateWorkerManager = function(updateDict) {
    //@note: @format:
    //transactions: array
    //last receive/change node indexes: integers.
    //current receive/change node addresses: null or string.

    if (typeof(updateDict) !== 'undefined' && updateDict !== null) {
        if (typeof(updateDict.clearTransactions) !== 'undefined' && updateDict.clearTransactions !== null) {
            if (updateDict.clearTransactions === true) {
                this._transactions = {};
            }
        }

        if (typeof(updateDict.transactions) !== 'undefined' && updateDict.transactions !== null) {
            for (var txid in updateDict.transactions) {
                this._transactions[txid] = updateDict.transactions[txid];
            }
        }

        if (typeof(updateDict.lastReceiveIndex) !== 'undefined' && updateDict.lastReceiveIndex !== null) {
            this._lastReceiveIndex = updateDict.lastReceiveIndex;
            this._currentReceiveAddress = updateDict.currentReceiveAddress;
            this._lastChangeIndex = updateDict.lastChangeIndex;
            this._currentChangeAddress = updateDict.currentChangeAddress;
        }

        if (typeof(updateDict.updated) !== 'undefined' && updateDict.updated !== null) {
            if (updateDict.updated === true) {
                this.update();
            }
        }
    }
}

HDWalletWorkerManager.prototype._populateHistory = function(addressData, passthroughParam) {
    var dateNow = (new Date()).getTime();
    var updated = false;

    if (!addressData || (addressData.status !== 'success' && addressData.status !== '1' && typeof(addressData.byAddress) === undefined)) {
        log("hdwalletworker :: " + this._coinType + " :: _populateHistory :: error :: addressData is not returning success" + JSON.stringify(addressData));
    }

    if (this._coinType === COIN_DASH) {
//        console.log("dash populate :: " + JSON.stringify(addressData));
    }

    this._coinWorkerImpl.populateHistory(dateNow, addressData, passthroughParam);
}


var hdWalletWorkerManager = new HDWalletWorkerManager();

onmessage = function(message) {
    if (message.data.action === 'initialize') {
        hdWalletWorkerManager.initialize(message.data.coinType, message.data.testNet);
    }
    if (message.data.action === 'setExtendedPublicKeys') {
        hdWalletWorkerManager.setExtendedPublicKeys(message.data.content.receive, message.data.content.change);
    } else if (message.data.action === 'restoreAddressMapCache') {
        var cache = message.data.content.workerCacheAddressMap;

        if (cache) {
            for (var address in cache) {
                hdWalletWorkerManager._addressMap[address] = cache[address];
                hdWalletWorkerManager._watchAddress(address);
            }
        }
    } else if (message.data.action == 'updateAddressMap') {
        var addressMapUpdate = message.data.content.addressMap;

        if (addressMapUpdate) {
            for (var address in addressMapUpdate) {
                hdWalletWorkerManager._addressMap[address] = addressMapUpdate[address];
            }
        }
    } else if (message.data.action === 'triggerExtendedUpdate') {
        if (message.data.content.type && message.data.content.type === 'balances') {
            setTimeout(function() {
                if (hdWalletWorkerManager._coinType === COIN_ETHEREUM) {
                    log("ethereum :: restore address map balance refresh");
                    hdWalletWorkerManager._coinWorkerImpl.updateBalances();
                }
            }, 10000);
        }
    }else if (message.data.action === 'refresh') {
        log("watcher :: " + hdWalletWorkerManager._coinType + " :: refreshing");

//        var crashy = this.will.crash;

//        log('Refreshing...');
        setTimeout(function () {
            setTimeout(function() {
                if (hdWalletWorkerManager._coinType === COIN_ETHEREUM) {
                    log("ethereum :: manual refresh balance refresh");
                    hdWalletWorkerManager._coinWorkerImpl.updateBalances();
                }
            }, 10000);

            hdWalletWorkerManager.checkTransactions(0);
        }, 0);
    } else if (message.data.action === 'shutDown') {
        hdWalletWorkerManager.shutDown();
    }
}

setInterval(function() {
    setTimeout(function() {
        if (hdWalletWorkerManager._coinType === COIN_ETHEREUM) {
            log("ethereum :: autorefresh balance refresh");
            hdWalletWorkerManager._coinWorkerImpl.updateBalances();
        }
    }, 10000);
    hdWalletWorkerManager.checkTransactions(HDWalletWorkerManager.getDefaultTransactionRefreshTime());
}, HDWalletWorkerManager.getDefaultTransactionRefreshTime() + 100);