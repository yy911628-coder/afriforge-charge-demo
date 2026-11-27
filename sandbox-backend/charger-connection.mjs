export const rivoniaSite=Object.freeze({country_code:'ZA',party_id:'AFE',location_id:'ZA41020001000001'});
export const rivoniaEvses=Object.freeze(['ZA41020001000001000100','ZA41020001000001000101']);
export function isRivoniaConnector(target) {
  return !!target && Object.entries(rivoniaSite).every(([key,value])=>target[key]===value) &&
    rivoniaEvses.includes(target.evse_uid) && target.connector_id===target.evse_uid+'01';
}

// An OCPI EVSE can have several connectors. An EVSE-wide cable signal only
// identifies a particular connector when it is the sole connector.
export function connectorState(evse, connector, target) {
  const status = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
  const evseStatus = status(evse.status) || 'UNKNOWN';
  const portStatus = status(connector.status);
  const single = evse.connectors?.length === 1;
  const startable = value => value === 'AVAILABLE' || value === 'PREPARING';
  let effective = !startable(evseStatus) ? evseStatus : portStatus || evseStatus;
  if (single && evseStatus==='RESERVED' && portStatus && !startable(portStatus) && isRivoniaConnector(target)) effective=portStatus;
  const explicit = typeof connector.vehicle_connected === 'boolean' ? connector.vehicle_connected :
    single && typeof evse.vehicle_connected === 'boolean' ? evse.vehicle_connected : null;
  let vehicle_connection = 'UNKNOWN';
  if (explicit === false) vehicle_connection = 'DISCONNECTED';
  else if (explicit === true || portStatus === 'PREPARING' || (!portStatus && single && evseStatus === 'PREPARING')) vehicle_connection = 'CONNECTED';
  return {status:effective, vehicle_connection};
}
