const packageJson = require('../package.json')

const fs = require('fs')
const path = require('path')
const el = require('./echonet-lite')
const buildAccessory = require('./accessory')

// Lazy-initialized.
let Accessory, hap

// Storage.
let storagePath = null
let storage = {accessories: {}}

// Called by homebridge.
module.exports = (homebridge) => {
  Accessory = homebridge.platformAccessory
  hap = homebridge.hap

  // Read settings.
  try {
    storagePath = path.join(homebridge.user.storagePath(), 'persist', 'ELPlatform.json')
    storage = JSON.parse(fs.readFileSync(storagePath))
  } catch {}

  // Register the platform.
  homebridge.registerPlatform(packageJson.name, "ELPlatform", ELPlatform, true)
}

// UUID for the refresh button.
const kRefreshUUID = '076cc8c6-7f72-441b-81cb-d85e27386dc1'

function setReachable(accessory, value) {
  // Homebridge v1系向け
  if (typeof accessory.updateReachability === 'function') {
    accessory.updateReachability(value)
  }

  // Homebridge v2系向け / このプラグイン内の探索管理用
  accessory.reachable = value
}

class ELPlatform {
  constructor(log, config, api) {
    this.log = log
    this.config = config
    this.api = api

    if (!this.config)
      return

    this.isDiscovering = false
    this.refreshSwitch = null

    this.accessories = new Map
    this.api.once('didFinishLaunching', () => this._init())
  }

  configureAccessory(accessory) {
    if (!this.accessories)
      return

    if (accessory.UUID === kRefreshUUID) {
      if (this.config.enableRefreshSwitch)
        this.refreshSwitch = accessory
      else
        this.api.unregisterPlatformAccessories(packageJson.name, "ELPlatform", [accessory])
      return
    }

    // Apply custom name from config if exists
    if (this.config.deviceNames && Array.isArray(this.config.deviceNames)) {
      const custom = this.config.deviceNames.find(d => d.id === accessory.UUID)
      if (custom && custom.name) {
        this.log(`Applying custom name from config for ${accessory.UUID}: ${custom.name}`)
        accessory.displayName = custom.name
      }
    }

    // Update basic accessory information
    const infoService = accessory.getService(hap.Service.AccessoryInformation)
    if (infoService) {
      infoService
        .setCharacteristic(hap.Characteristic.Manufacturer, "Panasonic")
        .setCharacteristic(hap.Characteristic.FirmwareRevision, packageJson.version)
    }

    this.accessories.set(accessory.UUID, accessory)
  }

  async _init() {
    await el.init()
    if (this.config.enableRefreshSwitch)
      await this._buildRefreshAccessory()

    if (this.accessories.size === 0) {
      await this._startDiscovery()
    } else {
      for (const [uuid, accessory] of this.accessories) {
        const info = storage.accessories[accessory.UUID]
        if (info) {
          this._addAccesory(info.address, info.eoj, accessory.UUID)
        } else {
          this.accessories.delete(uuid)
          this.api.unregisterPlatformAccessories(packageJson.name, "ELPlatform", [accessory])
        }
      }
    }
  }

  async _startDiscovery() {
    if (!this._setIsDiscovering(true))
      return

    this.accessories.forEach((accessory, uuid) => {
      setReachable(accessory, false)
    })

    return new Promise((resolve, reject) => {
      el.startDiscovery(async (err, res) => {
        if (err) {
          this.log(err)
          reject(err)
          return
        }

        const device = res.device
        const address = device.address

        for (const eoj of device.eoj) {
          if (!el.getClassName(eoj[0], eoj[1]))
            continue

          let uid = null
          let model = "WTY2201" // Default fallback

          try {
            // EPC 0x83: Identification Number
            const res83 = await el.getPropertyValue(address, eoj, 0x83)
            uid = res83.message.data.uid
          } catch {
            uid = address + '|' + JSON.stringify(eoj)
          }

          try {
            // EPC 0x8C: Production Number (contains model code like WTY2201)
            const res8C = await el.getPropertyValue(address, eoj, 0x8C)
            if (res8C && res8C.message.data && res8C.message.data.productionNumber) {
              model = res8C.message.data.productionNumber
            } else if (res8C && res8C.message.data && res8C.message.data.code) {
              model = res8C.message.data.code
            }
          } catch {}

          const uuid = hap.uuid.generate(uid)
          this.log(`Discovered device: address=${address}, eoj=${JSON.stringify(eoj)}, model=${model}, uid=${uid}, uuid=${uuid}`)
          
          await this._addAccesory(address, eoj, uuid, uid, model)
        }
      })

      setTimeout(() => {
        this._stopDiscovery()
        resolve()
      }, 10 * 1000)
    })
  }

  async _stopDiscovery() {
    if (!this._setIsDiscovering(false))
      return

    this.accessories.forEach((accessory, uuid) => {
      if (!accessory.reachable) {
        this.log(`Deleteing non-available accessory ${uuid}`)
        this.accessories.delete(uuid)
        this.api.unregisterPlatformAccessories(packageJson.name, "ELPlatform", [accessory])
        delete storage.accessories[uuid]
        writeSettings(this)
      }
    })
    this.log('Finished discovery')
    el.stopDiscovery()
  }

  async _setIsDiscovering(is) {
    if (is == this.isDiscovering)
      return false
    this.isDiscovering = is
    if (this.refreshService)
      this.refreshService.updateCharacteristic(hap.Characteristic.On, is)
    return true
  }

  async _buildRefreshAccessory() {
    if (!this.refreshSwitch) {
      this.refreshSwitch = new Accessory('Refresh ECHONET Lite', kRefreshUUID)
      this.api.registerPlatformAccessories(packageJson.name, "ELPlatform", [this.refreshSwitch])
    }
    this.refreshService = this.refreshSwitch.getService(hap.Service.Switch) ||
                          this.refreshSwitch.addService(hap.Service.Switch)
    this.refreshService.getCharacteristic(hap.Characteristic.On)
    .on('get', (callback) => {
      callback(null, this.isDiscovering)
    })
    .on('set', async (value, callback) => {
      if (value)
        await this._startDiscovery()
      else
        await this._stopDiscovery()
      callback()
    })
  }

  async _addAccesory(address, eoj, uuid, uid, model) {
    const registered = this.accessories.has(uuid)
    
    let name = el.getClassName(eoj[0], eoj[1])
    if (this.config.deviceNames && Array.isArray(this.config.deviceNames)) {
      const instanceStr = `eoj:${eoj[2]}`
      const custom = this.config.deviceNames.find(d => 
        d.id === uuid || 
        d.id === uid || 
        d.id === instanceStr ||
        d.id === eoj[2].toString()
      )
      if (custom && custom.name) {
        this.log(`Using custom name from config for ${uuid}: ${custom.name}`)
        name = custom.name
      }
    }

    let accessory = registered ? this.accessories.get(uuid)
                               : new Accessory(name, uuid)

    // Update Accessory Information
    const infoService = accessory.getService(hap.Service.AccessoryInformation)
    if (infoService) {
      infoService
        // .setCharacteristic(hap.Characteristic.Manufacturer, "Panasonic")
        .setCharacteristic(hap.Characteristic.FirmwareRevision, packageJson.version)
      
      if (model) {
        infoService.setCharacteristic(hap.Characteristic.Model, model)
      }
      if (uid) {
        infoService.setCharacteristic(hap.Characteristic.SerialNumber, uid)
      }
    }

    if (this.config.deviceNames && Array.isArray(this.config.deviceNames)) {
        const instanceStr = `eoj:${eoj[2]}`
        const custom = this.config.deviceNames.find(d => 
            d.id === uuid || d.id === uid || d.id === instanceStr || d.id === eoj[2].toString()
        )
        if (custom && custom.name) {
            accessory.displayName = custom.name
        }
    }

    if (!accessory.alreadyBuilt) {
      if (!await buildAccessory(hap, accessory, el, address, eoj))
        return
      accessory.alreadyBuilt = true
      accessory.once('identify', (paired, callback) => callback())
    }

    setReachable(accessory, true)

    if (!registered) {
      this.log(`Found new accessory: ${uuid}`)
      this.accessories.set(uuid, accessory)
      this.api.registerPlatformAccessories(packageJson.name, "ELPlatform", [accessory])
      storage.accessories[uuid] = {address, eoj}
      writeSettings(this)
    }
  }
}

function writeSettings(platform) {
  try {
    fs.writeFileSync(storagePath, JSON.stringify(storage))
  } catch (e) {
    platform.log(`Failed to write settings: ${e}`)
  }
}