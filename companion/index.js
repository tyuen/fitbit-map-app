import {outbox} from "file-transfer";
import {geolocation} from "geolocation";
import {peerSocket as peer} from "messaging";
import {Image} from "image";

let appId = "{YOUR_HERE_APP_ID}";  //your HERE Map developer ID
let baseUrl = "https://{subdomain}.{base}.maps.api.here.com/maptile/2.1/maptile/newest/{scheme}/{zxy}/256/jpg?app_id=" + appId;
let subDoms = [1, 2, 3, 4];
let subDomIdx = 0;

let reqNum = 0;

function onMessage({data}) {
  if(!data) return;
  if(data.gps) {
    geolocation.getCurrentPosition(p => {
      send({loc: {lat: p.coords.latitude, lon: p.coords.longitude}});
    }, err => {
      send({error: err.code === 1 ? "GPS denied" : err.code === 2 ? "GPS unavailable" : err.code === 3 ? "GPS timeout" : err.message});
    }, {
    enableHighAccuracy: true,
    maximumAge: 30000,
    timeout: 10000
  });
  }
  if(data.getTile) {
    let {x, y, z, type} = data.getTile;
    subDomIdx = (subDomIdx + 1) % subDoms.length;
    let curReq = reqNum;
    reqNum++;
    fetch(
      baseUrl.replace("{zxy}", z+"/"+x+"/"+y)
        .replace("{subdomain}", subDoms[subDomIdx])
        .replace("{base}", type === 0 ? "base" : "aerial")
        .replace("{scheme}", type === 0 ? "normal.day" : type === 1 ? "satellite.day" : "hybrid.day"),
      {cache: "force-cache"}
    ).then(res => {
      if(res.ok && reqNum - curReq <= 9) {
        res.arrayBuffer()
          .then(buf => Image.from(buf, "image/jpeg"))
          .then(img => img.export("image/jpeg", {quality: 40}))
          .then(buf => outbox.enqueue("tile"+x+"_"+y+"_"+z+"_"+type+".jpg", buf));
      } else {
        let o = {cancelTile: x+"_"+y+"_"+z+"_"+type};
        if(!res.ok) o.error = (res.status === 400) ? "Zoom Out" : res.status + " " + res.statusText;
        send(o);
      }
    }, err => {
      if(reqNum - 1 === curReq) send({error: err && err.message || err});
    });
  }
}

peer.onmessage = onMessage;

function send(o) {
  if(peer.readyState === peer.OPEN) peer.send(o);
}
