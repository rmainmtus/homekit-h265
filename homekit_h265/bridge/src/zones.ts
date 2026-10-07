import type {CameraZonesValue} from './SecureVideoTypes';
export function motionMask(value: CameraZonesValue | undefined, active: boolean, width: number, height: number): Uint8Array | undefined {
  if (!active || !value || !value.zones.length) return;
  if (value.version !== 2 || value.zones.length > 8) throw new Error('Unsupported zones');
  for (const zone of value.zones) {
    if (![1,2].includes(zone.method) || zone.polygons.length > 8) throw new Error('Invalid zone');
    for (const polygon of zone.polygons) {
      if (polygon.vertices.length < 3 || polygon.vertices.length > 64 || polygon.vertices.some(v=>!Number.isInteger(v.x)||!Number.isInteger(v.y)||v.x<0||v.y<0||v.x>width||v.y>height)) throw new Error('Invalid polygon');
    }
  }
  const inside=(x:number,y:number,vertices:{x:number;y:number}[])=>{
    let result=false;
    for(let i=0,j=vertices.length-1;i<vertices.length;j=i++) {
      const a=vertices[i],b=vertices[j];
      if ((a.y>y)!==(b.y>y) && x<(b.x-a.x)*(y-a.y)/(b.y-a.y)+a.x) result=!result;
    }
    return result;
  };
  const mask=new Uint8Array(160*180);
  for(let y=0;y<180;y++) for(let x=0;x<160;x++) {
    mask[y*160+x]=+value.zones.some(zone=>{
      const within=zone.polygons.some(p=>inside((x+0.5)*width/160,(y+0.5)*height/180,p.vertices));
      return zone.method===1?within:!within;
    });
  }
  return mask;
}
