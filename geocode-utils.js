const https = require('https');
const { addLog } = require('./email-utils');

const AMAP_KEY = process.env.AMAP_KEY || '3e60d7593481a44fc2234fac247e52f7';

const PI = Math.PI;
const a = 6378245.0;
const ee = 0.00669342162296594323;

function outOfChina(lng, lat) {
  return !(lng > 73.66 && lng < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(lng, lat) {
  let ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + 0.1 * lng * lat + 0.2 * Math.sqrt(Math.abs(lng));
  ret += (20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(lat * PI) + 40.0 * Math.sin(lat / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(lat / 12.0 * PI) + 320 * Math.sin(lat * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}

function transformLng(lng, lat) {
  let ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + 0.1 * lng * lat + 0.1 * Math.sqrt(Math.abs(lng));
  ret += (20.0 * Math.sin(6.0 * lng * PI) + 20.0 * Math.sin(2.0 * lng * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(lng * PI) + 40.0 * Math.sin(lng / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(lng / 12.0 * PI) + 300.0 * Math.sin(lng / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}

function gcj02ToWgs84(lng, lat) {
  if (outOfChina(lng, lat)) return { lng, lat };
  let dlat = transformLat(lng - 105.0, lat - 35.0);
  let dlng = transformLng(lng - 105.0, lat - 35.0);
  const radlat = lat / 180.0 * PI;
  let magic = Math.sin(radlat);
  magic = 1 - ee * magic * magic;
  const sqrtmagic = Math.sqrt(magic);
  dlat = (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * PI);
  dlng = (dlng * 180.0) / (a / sqrtmagic * Math.cos(radlat) * PI);
  return { lng: lng * 2 - (lng + dlng), lat: lat * 2 - (lat + dlat) };
}

function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return { lng, lat };
  let dlat = transformLat(lng - 105.0, lat - 35.0);
  let dlng = transformLng(lng - 105.0, lat - 35.0);
  const radlat = lat / 180.0 * PI;
  let magic = Math.sin(radlat);
  magic = 1 - ee * magic * magic;
  const sqrtmagic = Math.sqrt(magic);
  dlat = (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * PI);
  dlng = (dlng * 180.0) / (a / sqrtmagic * Math.cos(radlat) * PI);
  return { lng: lng + dlng, lat: lat + dlat };
}

function amapRequest(path) {
  return new Promise((resolve, reject) => {
    const url = `https://restapi.amap.com${path}&key=${AMAP_KEY}`;
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function geocode(address) {
  if (!AMAP_KEY) {
    addLog('error', '地理编码失败', '未配置高德地图API Key (AMAP_KEY)');
    return null;
  }

  try {
    const data = await amapRequest(`/v3/geocode/geo?address=${encodeURIComponent(address)}&extensions=all`);
    if (data.status === '1' && data.geocodes && data.geocodes.length > 0) {
      const geo = data.geocodes[0];
      const [lngStr, latStr] = geo.location.split(',');
      const gcjLng = parseFloat(lngStr);
      const gcjLat = parseFloat(latStr);
      const wgs = gcj02ToWgs84(gcjLng, gcjLat);

      const comp = geo.addressComponent || {};
      const name = [comp.province, comp.city, comp.district, comp.township].filter(Boolean).join('');

      addLog('success', '地理编码成功', `地址: ${address} → ${name} (${wgs.lng.toFixed(4)}, ${wgs.lat.toFixed(4)})`);

      return {
        lat: wgs.lat,
        lng: wgs.lng,
        name: name || address,
        formatted: geo.formatted_address || '',
        level: geo.level || '',
        province: comp.province || '',
        city: comp.city || '',
        district: comp.district || '',
        township: comp.township || ''
      };
    }
    addLog('info', '地理编码无结果', `地址: ${address}, info: ${data.info || 'unknown'}`);
    return null;
  } catch (err) {
    addLog('error', '地理编码请求失败', err.message);
    return null;
  }
}

async function reverseGeocode(lat, lng) {
  if (!AMAP_KEY) return null;

  try {
    const gcj = wgs84ToGcj02(lng, lat);
    const data = await amapRequest(`/v3/geocode/regeo?location=${gcj.lng.toFixed(6)},${gcj.lat.toFixed(6)}&extensions=base`);
    if (data.status === '1' && data.regeocode) {
      const comp = data.regeocode.addressComponent || {};
      const name = [comp.province, comp.city, comp.district, comp.township].filter(Boolean).join('');
      return name || data.regeocode.formatted_address || '';
    }
    return null;
  } catch (err) {
    addLog('error', '逆地理编码请求失败', err.message);
    return null;
  }
}

module.exports = { geocode, reverseGeocode, gcj02ToWgs84 };
