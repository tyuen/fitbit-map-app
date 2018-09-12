import document from "document";
import {inbox} from "file-transfer";
import fs from "fs";
import jpeg from "jpeg";
import {peerSocket as peer} from "messaging";
import {me} from "appbit";
import {display} from "display";
import {preferences} from "user-settings";
import {vibration} from "haptics";
import clock from "clock";

const TILE_SIZE = 256;

let frameWidth;
let frameHeight;

let curZoom = 17;
let curX = 5369190;  //my default: 37.78973, -122.39484, 16
let curY = 12967742;
let maxXY = 0;
let mapType = 0;

let cachedFiles = {};
let recentFiles = [];
let imageTiles = [];

let inFlight = {};
let flightQueue = [];

let titleNode = $("title");

let openSettings = false;

function $(id, node) {
  return node ? node.getElementById(id) : document.getElementById(id);
}

function init() {
  let data;
  try { data = fs.readFileSync("settings.txt", "cbor"); } catch(e) {}
  if(data) {
    curX = data.curX || 0;
    curY = data.curY || 0;
    curZoom = data.curZoom || 17;
  }

  data = null;
  try { data = fs.readFileSync("saved_files.txt", "cbor"); } catch(e) {}
  if(data) {
    recentFiles = data.recent;
    cachedFiles = data.cached;
  }
  
  let node = $("main");
  frameWidth = node.width;
  frameHeight = node.height;

  for(let i = 0; i < 9; i++) {  //6 needed for Ionic, 9 for Versa for full coverage
    let node = $("maptile" + i);
    imageTiles[i] = {
      img: node,
      loaded: false,  //to avoid setting the img href multiple times which causes flickers
      tileX: null,
      tileY: null,
      tileZ: null,
      type: null  //0=standard, 1=satellite, 2=hybrid
    };
    node.width = node.height = TILE_SIZE;
  }

  maxXY = 256*Math.pow(2, curZoom);  //max pixels determined by zoom level

  node = $("touch");
  node.onmousedown = onMouseDown;
  node.onmousemove = onMouseMove;

  node = $("all-btns");
  $("zoomin", node).onactivate = onZoomIn;
  $("zoomout", node).onactivate = onZoomOut;
  $("gps", node).onactivate = () => {
    peer.send({gps: 1});
    titleNode.text = "Acquiring...";
  };
  $("dots", node).onactivate = () => {
    openSettings = true;
    $("settings-panel").animate("enable");
    let {lat, lon} = getLatLon();
    $("lat", $("settings-tiles", $("settings-panel"))).text = lat;
    $("lon", $("settings-tiles", $("settings-panel"))).text = lon;
  };

  node = $("settings-tiles", $("settings-panel"));
  $("button", $("map_std", node)).onclick = () => {setMapType(0)};
  $("button", $("map_sat", node)).onclick = () => {setMapType(1)};
  $("button", $("map_hyb", node)).onclick = () => {setMapType(2)};

  $("err").onclick = () => {
    $("err").style.display = "none";
    $("crosshair").style.display = "inline";
  }
  $("copyright").text = "© "+new Date().getFullYear()+" HERE";

  if(me.permissions.granted("access_location")) {
    if(peer.readyState === peer.OPEN) {
      peer.send({gps: 1});
    } else if(flightQueue) {
      flightQueue.push({gps: 1});
    }
  }

  pendingFiles();
  inbox.onnewfile = pendingFiles;
}

init();

me.onunload = () => {
  fs.writeFileSync("settings.txt", {curX, curY, curZoom}, "cbor");
};

clock.granularity = "minutes";
clock.ontick = onTick;

function onTick() {
  let now = new Date();
  let hours = now.getHours();
  if(hours > 12 && preferences.clockDisplay === "12h") hours = hours % 12;
  let mins = now.getMinutes();
  if(mins < 10) mins = "0" + mins;

  titleNode.text = hours + ":" + mins;
};

function setMapType(i) {
  $("settings-panel").animate("disable");
  openSettings = false;
  mapType = i;
  for(let n of document.getElementsByClassName("color")) {
    n.style.fill = (i === 0) ? "#333333" : "#cccccc";
  }
  renderTiles(); 
}

function pendingFiles() {
  let tmp;
  while(tmp = inbox.nextFile()) {
    if(tmp.substr(0, 4) === "tile" && tmp.substr(-4) === ".jpg") {  //tilex_y_z_0.jpg
      let name = tmp.substr(4, tmp.length - 8);
      delete inFlight[name];
      cachedFiles[name] = "/private/data/" + name + ".txi";
      jpeg.decodeSync(tmp, name + ".txi", {"delete": true, overwrite: true});

      recentFiles.push(name);
      if(recentFiles.length > 15) {  //only keep the last 15 tiles
        let old = recentFiles.shift();
        fs.unlinkSync(old + ".txi");
        delete cachedFiles[old];
      }
    }
  }
  renderTiles();

  fs.writeFileSync("saved_files.txt", {recent: recentFiles, cached: cachedFiles}, "cbor");
}

peer.onmessage = ({data}) => {
  if(!data) return;
  if(data.cancelTile) {
    //if an HTTP error occurs or the tile request was superceeded by recent requests, then we clear the in-flight hash table
    delete inFlight[data.cancelTile];
  }
  if(data.loc) {
    moveToLatLon(data.loc.lat, data.loc.lon);
    titleNode.text = "Current Location";
    vibration.start("confirmation");
  }
  if(data.error) {
    let n = $("err");
    n.text = data.error;
    n.style.display = "inline";
    $("crosshair").style.display = "none";
  }
};

function moveToLatLon(lat, lon) {
  //copied from https://msdn.microsoft.com/en-us/library/bb259689.aspx
  lon = (lon < -180) ? -180 : (lon > 180) ? 180 : lon;
  lat = (lat < -85.05112878) ? -85.05112878 : (lat > 85.05112878) ? 85.05112878 : lat;  //cap lat
  let p = 256*Math.pow(2, curZoom);
  curX = ((lon + 180)/360)*p;
  let sinLat = Math.sin(lat*Math.PI/180);
  curY = (0.5 - Math.log((1 + sinLat)/(1 - sinLat))/(4*Math.PI))*p;
  renderTiles();
}

function getLatLon() {
  //copied from https://msdn.microsoft.com/en-us/library/bb259689.aspx
  let size = 256*Math.pow(2, curZoom);
  let x = curX/size - 0.5;
  let y = 0.5 - curY/size;
  return {
    lat: 90 - 360*Math.atan(Math.exp(-y*2*Math.PI))/Math.PI,
    lon: 360*x
  };
}

function renderTiles() {
  let tileX = Math.floor(curX/256);
  let tileY = Math.floor(curY/256);
  let tileZ = curZoom;

  let offsetX = curX % 256;
  let offsetY = curY % 256;

  let posX = frameWidth/2 - offsetX;
  let posY = frameHeight/2 - offsetY;

  let LAST = Math.pow(2, tileZ) - 1;
  
  let dirtyTiles = imageTiles.slice(0);
  let later = [];

  function doNowOrLater(tileX, tileY, posX, posY, name) {
    for(let i = dirtyTiles.length - 1; i >= 0; i--) {
      let t = dirtyTiles[i];
      if(t.tileX === tileX && t.tileY === tileY && t.tileZ === tileZ && t.type === mapType) {
        dirtyTiles.splice(i, 1);

        if(renderOneTile(t, tileX, tileY, tileZ, mapType, posX, posY)) {
          needTile(t, tileX, tileY, tileZ, mapType);
        }
        return;
      }
    }
    later.push([null, tileX, tileY, tileZ, mapType, posX, posY]);
  }

  doNowOrLater(
    tileX, tileY, posX, posY, "CC"
  );

  if(posX > 0) {  //fill mid left
    doNowOrLater(
      (tileX > 0) ? tileX - 1 : LAST, tileY,
      posX - TILE_SIZE, posY, "LC"
    );
  }
  if(posY > 0) {  //fill mid top
    doNowOrLater(
      tileX, (tileY > 0) ? tileY - 1 : LAST,
      posX, posY - TILE_SIZE, "TC"
    );
  }
  if(posX + TILE_SIZE < frameWidth) {  //fill mid right
    doNowOrLater(
      (tileX < LAST) ? tileX + 1 : 0, tileY,
      posX + TILE_SIZE, posY, "RC"
    );
  }
  if(posY + TILE_SIZE < frameHeight) {  //fill mid bottom
    doNowOrLater(
      tileX, (tileY < LAST) ? tileY + 1 : 0,
      posX, posY + TILE_SIZE, "BC"
    );
  }
  if(posX > 0 && posY > 0) {  //fill top left
    doNowOrLater(
      (tileX > 0) ? tileX - 1 : LAST,
      (tileY > 0) ? tileY - 1 : LAST,
      posX - TILE_SIZE, posY - TILE_SIZE, "TL"
    );
  }
  if(posX + TILE_SIZE < frameWidth && posY > 0) {  //fill top right
    doNowOrLater(
      (tileX < LAST) ? tileX + 1 : 0, (tileY > 0) ? tileY - 1 : LAST,
      posX + TILE_SIZE, posY - TILE_SIZE, "TR"
    );
  }
  if(posX + TILE_SIZE < frameWidth && posY + TILE_SIZE < frameHeight) {  //fill bottom right
    doNowOrLater(
      (tileX < LAST) ? tileX + 1 : 0, (tileY < LAST) ? tileY + 1 : 0,
      posX + TILE_SIZE, posY + TILE_SIZE, "BR"
    );
  }
  if(posX > 0 && posY + TILE_SIZE < frameHeight) {  //fill bottom left
    doNowOrLater(
      (tileX > 0) ? tileX - 1 : LAST, (tileY < LAST) ? tileY + 1 : 0,
      posX - TILE_SIZE, posY + TILE_SIZE, "BL"
    );
  }

  for(let args of later) {
    let t = dirtyTiles.pop();
    if(!t) break;  //shouldn't happen but hey.
    t.loaded = false;
    t.img.href = "blank.png";
    args[0] = t;
    if(renderOneTile.apply(this, args)) {
      needTile.apply(this, args);
    }
  }

  while(dirtyTiles.length) dirtyTiles.pop().img.style.display = "none";
  display.poke();
}

function renderOneTile(t, tileX, tileY, tileZ, mapType, posX, posY) {
  t.tileX = tileX;
  t.tileY = tileY;
  t.tileZ = tileZ;
  t.type = mapType;

  t.img.x = posX;
  t.img.y = posY;
  t.img.style.display = "inline";

  let id = tileX + "_" + tileY + "_" + tileZ + "_" + mapType;
  if(!t.loaded) {
    if(cachedFiles[id]) {
      t.loaded = true;
      t.img.href = cachedFiles[id];
    }
  }
  return !t.loaded;
}

function needTile(_, x, y, z, type) {
  let id = x + "_" + y + "_" + z + "_" + type;
  if(peer.readyState === peer.OPEN) {
    if(!inFlight[id]) {
      inFlight[id] = true;
      peer.send({getTile: {x, y, z, type}});
    }

  } else {
    titleNode.text = "Phone is offline";    
    if(flightQueue) {
      if(!inFlight[id]) {
        inFlight[id] = true;
        flightQueue.push({getTile: {x, y, z, type}});
      }
    }
  }
}

peer.onopen = e => {
  let q = flightQueue;
  if(q) {
    flightQueue = null;
    while(q.length) peer.send(q.pop());
  }
};

document.onkeypress = e => {
  if(e.key === "back" && openSettings) {
    openSettings = false;
    $("settings-panel").animate("disable");
    e.preventDefault();
  }
};

let mouseX = 0,
  mouseY = 0;

function onMouseDown(e) {
  mouseX = e.screenX;
  mouseY = e.screenY;
}

function onMouseMove(e) {
  let x = mouseX - e.screenX;
  let y = mouseY - e.screenY;
  if(x !== 0 || y !== 0) {
    curX = (curX + x) % maxXY;
    curY = (curY + y) % maxXY;
    if(curX < 0) curX = maxXY + curX;
    if(curY < 0) curY = maxXY + curY;
    renderTiles();
    mouseX = e.screenX;
    mouseY = e.screenY;
  }
}

let delayTimer;
function delayInvoke(fn) {
  //avoid downloading tiles when the user wants to skip between  zoom levels
  clearTimeout(delayTimer);
  delayTimer = setTimeout(fn, 500);
}

function onZoomIn() {
  if(curZoom < 23) {
    curZoom++;
    maxXY = 256*Math.pow(2, curZoom);
    curX *= 2;
    curY *= 2;
    delayInvoke(renderTiles); 
  }
}

function onZoomOut() {
  if(curZoom > 0) {
    curZoom--;
    maxXY = 256*Math.pow(2, curZoom);
    curX = Math.floor(curX/2);
    curY = Math.floor(curY/2);
    delayInvoke(renderTiles);
  }
}
