const { WebSocket } = require('ws');
const EventEmitter = require('events');

/**
 * @typedef {string} Block
 *  A block string consisting of a resource location[0] and a list of
 *  comma-seperated block states in brackets.
 *  [0] https://minecraft.fandom.com/wiki/Resource_location
 *  e.g.
 *  - `minecraft:chest[facing=north,type=single,waterlogged=false]`
 *  - `minecraft:redstone_wire[east=side,north=none,power=5,south=up,west=none]`
 */

/**
 * @typedef {Error} CraftError
 * @prop {String} CraftError.type
 *   one of "connection closed", "unauthenticated", "invalid operation",
 *   "bad request", "out of fuel" or "offline".
 */

/**
 * @typedef {Object} Entity
 * @prop {String} Entity.type
 * @prop {String} Entity.name
 * @prop {number?} Entity.health
 * @prop {number?} Entity.max_health
 * @prop {String?} Entity.player_uuid
 * @prop {number} Entity.x
 * @prop {number} Entity.y
 * @prop {number} Entity.z
 */

/**
 * @typedef {Object} Item
 * @prop {number} Item.index
 * @prop {String} Item.type
 * @prop {number} Item.amount
 */

/**
 * @typedef {Object} ItemReference
 * @prop {number} ItemReference.index the container slot this item is in
 * @prop {number} ItemReference.x the x coordinate of the container this item is in
 * @prop {number} ItemReference.y the y coordinate of the container this item is in
 * @prop {number} ItemReference.z the z coordinate of the container this item is in
 */

/** @typedef {number[]} XYZ A tuple of x, y, z coordinates */
/** @event open */
/** @event close */
/**
 * @event error
 * @param {CraftError} the error that occured
 */

/**
 * @event block update
 * @param {string} cause
 *   The cause of the update. One of: "poll" "burn" "break" "explode"
 *   "fade" "grow" "ignite" "piston_extend" "piston_retract" "place"
 *   "fluid" "decay" "redstone"
 * @param {Block} block the new state of the block
 * @param {number} x the x coordinate of the block that changed
 * @param {number} y the y coordinate of the block that changed
 * @param {number} z the z coordinate of the block that changed
 */

/**
 * @event transact
 * @param {Object} transaction
 * @prop {String} transaction.query the text used in the /transact command, excluding the initial amount
 * @prop {number} transaction.amount The amount of money being offered in the transaction
 * @prop {String} transaction.player the username of the player using the /transact command
 * @prop {String} transaction.player_uuid the uuid of the player using the /transact command
 * @prop {TransactionControl} transaction.accept Accepts the transaction, depositing the money into your account
 * @prop {TransactionControl} transaction.deny Denies the transaction, refunding the money
 */

/**
 * @callback TransactionControl
 * @returns {Promise}
 */

/**
 * @event outOfFuel
 * @param {CraftError} the out of fuel error
 */

/**
 * A client for interacting with the ReplCraft server
 * @fires outOfFuel when a request encounters an out-of-fuel error
 * @fires transact when a player uses the /transact command inside the structure
 */
class Client extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.handlers = null;
    this.nonce = 0;
    this.retryFuelErrors = false;
    this.retryQueue = [];
    this.__processRetryQueue();
  }

  /**
   * Starts a task to process the retry queue
   * @private
   */
  async __processRetryQueue() {
    while (true) {
      await new Promise(res => this.once("__queueFilled", res));
      while (this.retryQueue.length > 0) {
        let { args, resolve, reject } = this.retryQueue.splice(0, 1)[0];
        this.request(args).then(resolve).catch(reject);
      }
    }
  }

  /**
   * Logs the client in and returns a promise that resolves once authenticated.
   * @param {String} token your api token
   * @return {Promise}
   * @throws {CraftError}
   * @fires open
   * @fires close
   * @fires error
   */
  login(token) {
    if (this.ws) this.ws.close();
    token = token.replace(/\s*(http:\/\/)?\s*/, "");
    let config = JSON.parse(atob(token.split('.')[1]));
    this.ws = new WebSocket("ws://" + config.host + "/gateway", {});
    this.handlers = new Map();
    
    this.ws.on('close', () => {
      this.emit('close');
      for (let [_nonce, handler] of this.handlers.entries()) {
        handler({ ok: false, error: "connection closed", message: "connection closed" });
      }
      this.handlers = null;
      this.ws = null;
    });

    this.ws.on('error', err => {
      this.emit('error', err);
    });

    this.ws.on('message', json => {
      let msg = JSON.parse(json);
      if (this.handlers.has(msg.nonce)) {
        this.handlers.get(msg.nonce)(msg);
        this.handlers.delete(msg.nonce);
      }
      switch (msg.type) {
        case "block update":
          this.emit("block update", msg.cause, msg.block, msg.x, msg.y, msg.z);
          break;

        case "transact":
          this.emit("transact", {
            query: msg.query,
            amount: msg.amount,
            player: msg.player,
            player_uuid: msg.player_uuid,
            accept: () => {
              return this.request({
                action: 'respond',
                queryNonce: msg.queryNonce,
                accept: true
              });
            },
            deny: () => {
              return this.request({
                action: 'respond',
                queryNonce: msg.queryNonce,
                accept: false
              });
            }
          });
          break;
      }
      if (msg.event) {
        this.emit(msg.event, msg.cause, msg.block, msg.x, msg.y, msg.z);
      }
    });

    return new Promise((res, rej) => {
      this.ws.once('open', () => {
        this.emit('open');
        this.request({ action: 'authenticate', token }).then(res).catch(rej);
      });
    });
  }

  /** 
   * Retrieves the inner size of the structure
   * @param {number} x the inner size of the structure in the x coordinate
   * @param {number} y the inner size of the structure in the y coordinate
   * @param {number} z the inner size of the structure in the z coordinate
   * @return {Promise<XYZA>}
   * @throws {CraftError}
   */
  getSize(x, y, z) {
    return this.request({ action: 'get_size', x, y, z }).then(r => [r.x, r.y, r.z]);
  }

  /** 
   * Retrieves the world coordinate location of the (0,0,0) inner coordinate
   * @return {Promise<XYZ>}
   * @throws {CraftError}
   */
  location() {
    return this.request({ action: 'get_location', x, y, z }).then(r => [r.x, r.y, r.z]);
  }

  /** 
   * Retrieves a block at the given structure-local coordinates.
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @return {Promise<Block>}
   * @throws {CraftError}
   */
  getBlock(x, y, z) {
    return this.request({ action: 'get_block', x, y, z }).then(r => r.block);
  }

  /** 
   * Sets a block at the given structure-local coordinates. The block must be available
   * in the specified source chest or the structure inventory. Any block replaced by this call
   * is stored in the specified target chest or the structure inventory, or dropped in the
   * world if there's no space.
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @param {Block} blockData
   * @param {number?} source_x the x coordinate of the container to take the block from
   *                           if excluded, uses the structure inventory instead.
   * @param {number?} source_y the y coordinate of the container to take the block from
   *                           if excluded, uses the structure inventory instead.
   * @param {number?} source_z the z coordinate of the container to take the block from
   *                           if excluded, uses the structure inventory instead.
   * @param {number?} target_x the x coordinate of the container to put the drops into
   *                           if excluded, uses the structure inventory instead.
   * @param {number?} target_y the y coordinate of the container to put the drops into
   *                           if excluded, uses the structure inventory instead.
   * @param {number?} target_z the z coordinate of the container to put the drops into
   *                           if excluded, uses the structure inventory instead.
   * @return {Promise}
   * @throws {CraftError}
   */
  setBlock(
    x, y, z,
    blockData,
    source_x=null, source_y=null, source_z=null,
    target_x=null, target_y=null, target_z=null
  ) {
    return this.request({
      action: 'set_block',
      x, y, z,
      blockData,
      source_x, source_y, source_z,
      target_x, target_y, target_z
    }).then(() => {});
  }

  

  /** 
   * Retrieves the text of a sign at the given coordinates
   * @param {number} x the x coordinate of the sign (container relative)
   * @param {number} y the y coordinate of the sign (container relative)
   * @param {number} z the z coordinate of the sign (container relative)
   * @return {Promise<string[]>}
   * @throws {CraftError}
   */
  getSignText(x, y, z) {
    return this.request({ action: 'get_sign_text', x, y, z }).then(r => r.lines);
  }

  /** 
   * Sets the text of a sign at the given coordinates
   * @param {number} x the x coordinate of the sign (container relative)
   * @param {number} y the y coordinate of the sign (container relative)
   * @param {number} z the z coordinate of the sign (container relative)
   * @param {string[]} lines the lines of text to set the sign to
   * @return {Promise}
   * @throws {CraftError}
   */
  setSignText(x, y, z, lines) {
    return this.request({ action: 'set_sign_text', x, y, z, lines }).then(() => {});
  }

  /** 
   * Begins watching a block for updates.
   * Note that this isn't perfectly reliable and doesn't catch all possible updates.
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @fires block update
   * @return {Promise}
   * @throws {CraftError}
   */
  watch(x, y, z) {
    return this.request({ action: 'watch', x, y, z }).then(() => {});
  }

  /** 
   * Stops watching a block for updates
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @return {Promise}
   * @throws {CraftError}
   */
  unwatch(x, y, z) {
    return this.request({ action: 'unwatch', x, y, z }).then(() => {});
  }

  /** 
   * Begins watching all blocks in the structure for updates.
   * Note that this isn't perfectly reliable and doesn't catch all possible updates.
   * @fires block update
   * @return {Promise}
   * @throws {CraftError}
   */
  watchAll() {
    return this.request({ action: 'watch_all' }).then(() => {});
  }

  /** 
   * Stops watching all blocks for updates.
   * @return {Promise}
   * @throws {CraftError}
   */
  unwatchAll() {
    return this.request({ action: 'unwatch_all' }).then(() => {});
  }

  /** 
   * Begins polling a block for updates.
   * Note that this catches all possible block updates, but only one block is polled per tick.
   * The more blocks you poll, the slower each individual block will be checked.
   * Additionally, if a block changes multiple times between polls, only the latest change
   * will be reported.
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @fires block update
   * @return {Promise}
   * @throws {CraftError}
   */
  poll(x, y, z) { return this.request({ action: 'poll', x, y, z }).then(() => {}); }

  /** 
   * Stops watching a block for updates
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @return {Promise}
   * @throws {CraftError}
   */
  unpoll(x, y, z) { return this.request({ action: 'unpoll', x, y, z }).then(() => {}); }

  /** 
   * Begins polling all blocks in the structure for updates.
   * Updates will be very slow!
   * @fires block update
   * @return {Promise}
   * @throws {CraftError}
   */
  pollAll() {
    return this.request({ action: 'poll_all' }).then(() => {});
  }

  /** 
   * Stops polling all blocks in the structure.
   * @return {Promise}
   * @throws {CraftError}
   */
  unpollAll() {
    return this.request({ action: 'unpoll_all' }).then(() => {});
  }

  /** 
   * Gets all entities inside the region
   * @return {Promise<Entity[]>}
   * @throws {CraftError}
   */
  getEntities() {
    return this.request({ action: 'get_entities' }).then(r => r.entities);
  }

  /** 
   * Gets all items from a container such as a chest or hopper
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @return {Promise<Item[]>}
   * @throws {CraftError}
   */
  getInventory(x, y, z) {
    return this.request({ action: 'get_inventory', x, y, z }).then(r => r.items);
  }

  /** 
   * Moves an item between containers
   * @param {number} index the item index in the source container
   * @param {number} source_x the x coordinate of the source container (container relative)
   * @param {number} source_y the y coordinate of the source container (container relative)
   * @param {number} source_z the z coordinate of the source container (container relative)
   * @param {number} target_x the x coordinate of the source container (container relative)
   * @param {number} target_y the y coordinate of the source container (container relative)
   * @param {number} target_z the z coordinate of the source container (container relative)
   * @param {number|null} target_index the target index in the destination container, or any if null
   * @param {number|null} amount the amount of items to move, or all if null
   * @return {Promise}
   * @throws {CraftError}
   */
  moveItem(index, source_x, source_y, source_z, target_x, target_y, target_z, target_index=null, amount=null) {
    return this.request({
      action: 'move_item',
      amount,
      index, source_x, source_y, source_z,
      target_index, target_x, target_y, target_z
    }).then(() => {});
  }
  
  /**
   * Gets a block's redstone power level
   * @param {number} x the x coordinate of the block (container relative)
   * @param {number} y the y coordinate of the block (container relative)
   * @param {number} z the z coordinate of the block (container relative)
   * @return {Promise<number>}
   * @throws {CraftError}
   */
  getPowerLevel(x, y, z) {
    return this.request({ action: 'get_power_level', x, y, z }).then(r => r.power);
  }

  /**
   * Sends a message to a player. The player must be online and inside
   * the structure.
   * @param {string} target the name or UUID of the player
   * @param {string} message the message to send to the player
   * @return {Promise}
   * @throws {CraftError}
   */
  tell(target, message) {
    return this.request({ action: 'tell', target, message }).then(() => {});
  }

  /**
   * Sends money to a player out of your own account
   * @param {string} target the name or UUID of the player
   * @param {number} amount the amount of money to send
   * @return {Promise}
   * @throws {CraftError}
   */
  pay(target, amount) {
    return this.request({ action: 'pay', target, amount }).then(() => {});
  }

  /**
   * Crafts an item, which is then stored into the given container
   * @param {number} x the x coordinate of the output container
   * @param {number} y the y coordinate of the output container
   * @param {number} z the z coordinate of the output container
   * @param {ItemReference[]} ingredients the ingredients for the recipe
   * @return {Promise}
   * @throws {CraftError}
   */
  craft(x, y, z, ingredients) {
    return this.request({ action: 'craft', x, y, z, ingredients }).then(() => {});
  }

  /**
   * Enables or disables automatic retries when out of fuel.
   * Note that requests will hang indefinitely until fuel is supplied.
   * You can monitor fuel status by listening to the "outOfFuel" event
   * @param {boolean} retry if retries should be enabled or disabled
   */
  retryOnFuelError(retry=true) {
    this.retryFuelErrors = retry;
  }

  /** Disconnects the client */
  disconnect() {
    if (this.ws) {
      this.ws.close();
    }
  }

  /**
   * Makes a request to the server. You probably shouldn't use this directly.
   * @param {Object} args: the request to make
   * @return {Promise<Object>}
   * @throws {CraftError}
   */
  async request(args) {
    if (!this.ws) {
      let error = new Error("connection closed");
      error.type = "connection closed";
      throw error;
    }
    let nonce = (this.nonce++).toString();
    let request = { ...args, nonce };
    this.ws.send(JSON.stringify(request));

    return await new Promise((res, rej) => {
      this.handlers.set(nonce, response => {
        if (!response.ok) {
          let error = new Error(response.error + ': ' + response.message);
          error.type = response.error;
          if (response.error == 'out of fuel') {
            this.emit("outOfFuel", error);
          }
          if (response.error == 'out of fuel' && this.retryFuelErrors) {
            setTimeout(() => {
              this.retryQueue.push({ args, resolve: res, reject: rej });
              this.emit("__queueFilled");
            }, 500);
          } else {
            rej(error);
          }
        } else {
          res(response);
        }
      });
    });
  }
}

module.exports = Client;
