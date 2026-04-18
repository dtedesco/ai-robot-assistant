export const ROBERT_BLE_NAME = "Robert_ble";
export const ROBERT_SERVICE_UUID = "0000ffc0-0000-1000-8000-00805f9b34fb";
export const ROBERT_WRITE_CHAR_UUID = "0000ffc1-0000-1000-8000-00805f9b34fb";
export const ROBERT_NOTIFY_CHAR_UUID = "0000ffc2-0000-1000-8000-00805f9b34fb";

export interface BLEDevice {
  address: string;
  name: string | null;
  rssi: number;
}
