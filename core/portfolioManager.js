/*

  The portfolio manager is responsible for making sure that
  all decisions are turned into orders and make sure these orders
  get executed. Besides the orders the manager also keeps track of
  the client's portfolio.

*/

var _ = require('lodash');
var util = require('./util');
var events = require("events");
var log = require('./log');
var async = require('async');
var checker = require('./exchangeChecker.js');

var Manager = function(conf) {
  _.bindAll(this);

  var error = checker.cantTrade(conf)
  if(error)
    util.die(error);

  var exchangeMeta = checker.settings(conf);
  this.exchangeSlug = exchangeMeta.slug;

  // create an exchange
  var Exchange = require('../exchanges/' + this.exchangeSlug);
  this.exchange = new Exchange(conf);

  this.conf = conf;
  this.portfolio = {};
  this.fee;
  this.order;
  this.action;

  this.lastSell;
  this.lastBuy;

  this.directExchange = exchangeMeta.direct;
  this.infinityOrderExchange = exchangeMeta.infinityOrder;

  this.marketConfig = _.find(exchangeMeta.markets, function(p) {
    return p.pair[0] === conf.currency && p.pair[1] === conf.asset;
  });
  this.minimalOrder = this.marketConfig.minimalOrder;

  this.lossAvoidant = conf.lossAvoidant;
  this.tradePercent = conf.tradePercent;
  this.currency = conf.currency;
  this.asset = conf.asset;
}

Manager.prototype.init = function(callback) {
  log.debug('getting balance & fee from', this.exchange.name);
  var prepare = function() {
    this.starting = false;

    log.info('trading at', this.exchange.name, 'ACTIVE');
    log.info(this.exchange.name, 'trading fee will be:', this.fee * 100 + '%');
    this.logPortfolio();

    callback();
  };

  async.series([
    this.setPortfolio,
    this.setFee
  ], _.bind(prepare, this));

  // Because on cex.io your asset grows refresh and
  // display portfolio stats every 5 minutes
  if(this.exchange.name === 'cex.io')
    setInterval(this.recheckPortfolio, util.minToMs(5));  
}

Manager.prototype.setPortfolio = function(callback) {
  var set = function(err, portfolio) {
    this.portfolio = portfolio;
    
    if(_.isFunction(callback))
      callback();
  };
  this.exchange.getPortfolio(_.bind(set, this));
}

Manager.prototype.setFee = function(callback) {
  var set = function(err, fee) {
    this.fee = fee;
    
    if(_.isFunction(callback))
      callback();
  };
  this.exchange.getFee(_.bind(set, this));
}

Manager.prototype.setTicker = function(callback) {
  var set = function(err, ticker) {
    this.ticker = ticker;
    
    if(_.isFunction(callback))
      callback();
  }
  this.exchange.getTicker(_.bind(set, this));
}

// return the [fund] based on the data we have in memory
Manager.prototype.getFund = function(fund) {
  return _.find(this.portfolio, function(f) { return f.name === fund});
}
Manager.prototype.getBalance = function(fund) {
  return this.getFund(fund).amount;
}

// This function makes sure order get to the exchange
// and initiates follow up to make sure the orders will
// get executed. This is the backbone of the portfolio 
// manager.
// 
// How this is done depends on a couple of things:
// 
// is this a directExchange? (does it support MKT orders)
// is this a infinityOrderExchange (does it support order
// requests bigger then the current balance?)
Manager.prototype.trade = function(what) {
  if(what !== 'BUY' && what !== 'SELL')
    return;

  this.action = what;

  var act = function() {
    var amount, price, total_balance;

    total_balance = this.getBalance(this.currency) + this.getBalance(this.asset) * this.ticker.bid;

    if(what === 'BUY') {


      // do we need to specify the amount we want to buy?
      if(this.infinityOrderExchange)
        amount = 10000;
      else
        amount = this.getBalance(this.currency) / this.ticker.ask;

      // can we just create a MKT order?
      if(this.directExchange)
        price = false;
      else
        price = this.ticker.ask;

      if(this.tradePercent) {
        log.debug('Trade Percent: adjusting amount', amount, 'by ', this.tradePercent, '%');
        amount = amount * this.tradePercent / 100;
      }

      if(this.lossAvoidant && this.lastSell && price > this.lastSell ) {
        log.info('We are Loss Avoidant.  Got advice to buy at ', price, 'but our last selling price was ', this.lastSell);
        log.info('Skipping this trend.');
      }
      else {
        this.buy(amount, price);
        this.lastBuy = price;
      }

    } else if(what === 'SELL') {

      // do we need to specify the amount we want to sell?
      if(this.infinityOrderExchange)
        amount = 10000;
      else
        amount = this.getBalance(this.asset);

      // can we just create a MKT order?
      if(this.directExchange)
        price = false;
      else
        price = this.ticker.bid;

      if(this.tradePercent) {
        log.debug('Trade Percent: adjusting amount', amount, 'by ', this.tradePercent, '%');
        amount = amount * this.tradePercent / 100;
      }
      if(this.lossAvoidant && this.lastBuy && price < this.lastBuy ) {
        log.info('We are Loss Avoidant.  Got advice to sell at ', price, 'but our last buying price was ', this.lastBuy);
        log.info('Skipping this trend.');
      }
      else {
        this.sell(amount, price);
      }
    }
  };
  async.series([
    this.setTicker,
    this.setPortfolio
  ], _.bind(act, this));

}

Manager.prototype.getMinimum = function(price) {
  if(this.minimalOrder.unit === 'currency')
    return minimum = this.minimalOrder.amount / price;
  else
    return minimum = this.minimalOrder.amount;
}

// first do a quick check to see whether we can buy
// the asset, if so BUY and keep track of the order
// (amount is in asset quantity)
Manager.prototype.buy = function(amount, price) {
  // sometimes cex.io specifies a price w/ > 8 decimals
  price *= 100000000;
  price = Math.floor(price);
  price /= 100000000;

  var currency = this.getFund(this.currency);
  var minimum = this.getMinimum(price);
  var availabe = this.getBalance(this.currency) / price;
  log.debug('Buying ', amount, 'with ', availabe, 'available, and a minimum of', minimum);
  // if not suficient funds
  if(amount > availabe) {
    return log.info(
      'wanted to buy but insufficient',
      this.currency,
      '(' + availabe + ')',
      'at',
      this.exchange.name
    );
  }

  // if order too small
  if(amount < minimum) {
    return log.info(
      'wanted to buy',
      this.asset,
      'but the amount is too small',
      '(' + amount + ')',
      'at',
      this.exchange.name
    );
  }

  log.info(
    'attempting to BUY',
    amount,
    this.asset,
    'at',
    this.exchange.name
  );
  this.exchange.buy(amount, price, this.noteOrder);
}

// first do a quick check to see whether we can sell
// the asset, if so SELL and keep track of the order
// (amount is in asset quantity)
Manager.prototype.sell = function(amount, price) {
  // sometimes cex.io specifies a price w/ > 8 decimals
  price *= 100000000;
  price = Math.ceil(price);
  price /= 100000000;

  var minimum = this.getMinimum(price);
  var availabe = this.getBalance(this.asset);
  log.debug('Selling ', amount, 'with ', availabe, 'available, and a minimum of', minimum);
  // if not suficient funds
  if(amount > availabe) {
    return log.info(
      'wanted to buy but insufficient',
      this.asset,
      '(' + availabe + ')',
      'at',
      this.exchange.name
    );
  }

  // if order too small
  if(amount < minimum) {
    return log.info(
      'wanted to buy',
      this.currency,
      'but the amount is too small',
      '(' + amount + ')',
      'at',
      this.exchange.name
    );
  }

  log.info(
    'attempting to SELL',
    amount,
    this.asset,
    'at',
    this.exchange.name
  );
  this.exchange.sell(amount, price, this.noteOrder);
}

Manager.prototype.noteOrder = function(err, order) {
  this.order = order;
  // if after 30 seconds the order is still there
  // we cancel and calculate & make a new one
  setTimeout(this.checkOrder, util.minToMs(0.5));
}

// check wether the order got fully filled
// if it is not: cancel & instantiate a new order
Manager.prototype.checkOrder = function() {
  var finish = function(err, filled) {
    if(!filled) {
      log.info(this.action, 'order was not (fully) filled, cancelling and creating new order');
      this.exchange.cancelOrder(this.order);

      // Delay the trade, as cancel -> trade can trigger
      // an error on cex.io if they happen on the same
      // unix timestamp second (nonce will not increment).
      var self = this;
      setTimeout(function() { self.trade(self.action); }, 1000);
      return;
    }

    log.info(this.action, 'was successfull');
  }

  this.exchange.checkOrder(this.order, _.bind(finish, this));
}

Manager.prototype.logPortfolio = function() {
  log.info(this.exchange.name, 'portfolio:');
  _.each(this.portfolio, function(fund) {
    log.info('\t', fund.name + ':', fund.amount.toFixed());
  });
}

// On cex.io the portfolio gets updated as new blocks
// come in when we are holding the asset.
Manager.prototype.recheckPortfolio = function() {
  this.setPortfolio(this.enforcePosition);
}


// If we are in a long position we are bullish
// and thus want to reinvest earnings back into
// the asset (GHS) as we are assuming the value
// of the asset will go up.
Manager.prototype.enforcePosition = function() {
  if(this.action !== 'BUY')
    return;

  this.trade('BUY');
}

module.exports = Manager;
