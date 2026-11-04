/** Image coordinates are centred in the viewport; x/y are CSS pixels, scale 1 is fitted. */
export interface ImageView { x: number; y: number; scale: number }
export interface ImageBounds { width: number; height: number; imageWidth: number; imageHeight: number }
export const IMAGE_HOME: ImageView = {x:0,y:0,scale:1};
export const IMAGE_MAX_ZOOM = 8;
export function fittedImage(b: ImageBounds) {
  const k=Math.min(1,b.width/Math.max(1,b.imageWidth),b.height/Math.max(1,b.imageHeight));
  return {width:b.imageWidth*k,height:b.imageHeight*k};
}
export function clampImageView(v: ImageView,b: ImageBounds): ImageView {
  const scale=Math.max(1,Math.min(IMAGE_MAX_ZOOM,Number.isFinite(v.scale)?v.scale:1));
  const fit=fittedImage(b),lx=Math.max(0,(fit.width*scale-b.width)/2),ly=Math.max(0,(fit.height*scale-b.height)/2);
  return {scale,x:Math.max(-lx,Math.min(lx,Number.isFinite(v.x)?v.x:0)),y:Math.max(-ly,Math.min(ly,Number.isFinite(v.y)?v.y:0))};
}
/** Anchor can move during a pinch: the same image point follows the fingers' midpoint. */
export function zoomImage(v: ImageView,factor: number,from: {x:number;y:number},to: {x:number;y:number},b: ImageBounds) {
  const scale=Math.max(1,Math.min(IMAGE_MAX_ZOOM,v.scale*factor)),r=scale/v.scale;
  return clampImageView({scale,x:to.x-(from.x-v.x)*r,y:to.y-(from.y-v.y)*r},b);
}
