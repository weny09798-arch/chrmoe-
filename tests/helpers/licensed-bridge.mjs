export const licensedStatus = {allowed:true,status:'active',expires_at:2000000000,lease_until:1900000000,offline:false,message:'授权有效',remaining_days:30,checked_at:1800000000};
// Explicit fake authority for pre-existing collection/conversion fixtures.
export function licensedFetch(fetch) {
  return async (url,options) => url.includes('/api/bridge/license/') ? {ok:true,json:async()=>licensedStatus} : fetch(url,options);
}
export function installLicensedBridgeFixture() {
  const saved=new Map([['collector-image-bridge',JSON.stringify({baseUrl:'http://localhost:53121',token:'fixture-pair'})]]);
  globalThis.sessionStorage={getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
  globalThis.fetch=licensedFetch(async url=>({ok:true,json:async()=>url.endsWith('/capabilities')?{licensing:true,providers:['doubao'],image_link_replacement:true,cloud_image_storage:true,oss_configured:true,image_type_limits:true}: {}}));
}
