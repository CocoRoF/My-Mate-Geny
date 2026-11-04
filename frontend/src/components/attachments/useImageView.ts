import {useEffect,useRef,useState} from 'react';
import {clampImageView,fittedImage,IMAGE_HOME,zoomImage,type ImageBounds,type ImageView} from './imageView';

export function useImageView(imageSize: {width:number;height:number}) {
  const area=useRef<HTMLDivElement>(null),current=useRef<ImageView>(IMAGE_HOME);
  const bounds=useRef<ImageBounds>({width:0,height:0,imageWidth:imageSize.width,imageHeight:imageSize.height});
  const [view,setView]=useState(IMAGE_HOME),[fit,setFit]=useState({width:0,height:0}),[dragging,setDragging]=useState(false);
  const suppressClick=useRef(false),onImage=useRef(false);
  const put=(v:ImageView)=>{current.current=clampImageView(v,bounds.current);setView(current.current)};
  const reset=()=>put(IMAGE_HOME);
  const zoom=(factor:number)=>put(zoomImage(current.current,factor,{x:0,y:0},{x:0,y:0},bounds.current));
  useEffect(()=>{
    const el=area.current;if(!el)return;
    const measure=()=>{const r=el.getBoundingClientRect();bounds.current={width:r.width,height:r.height,imageWidth:imageSize.width,imageHeight:imageSize.height};setFit(fittedImage(bounds.current));put(current.current)};
    measure();const observer=new ResizeObserver(measure);observer.observe(el);
    const points=new Map<number,{x:number;y:number}>();
    let origin:{x:number;y:number}|null=null;
    const center=(p:{x:number;y:number})=>{const r=el.getBoundingClientRect();return {x:p.x-r.left-r.width/2,y:p.y-r.top-r.height/2}};
    const wheel=(e:WheelEvent)=>{
      e.preventDefault();e.stopPropagation();
      const unit=e.deltaMode===1?16:e.deltaMode===2?bounds.current.height:1;
      const p=center({x:e.clientX,y:e.clientY});put(zoomImage(current.current,Math.exp(-e.deltaY*unit*.002),p,p,bounds.current));
    };
    const down=(e:PointerEvent)=>{
      if(e.pointerType==='mouse'&&e.button!==0)return;
      if(points.size===0){suppressClick.current=false;onImage.current=(e.target as HTMLElement).tagName==='IMG';origin={x:e.clientX,y:e.clientY}}
      points.set(e.pointerId,{x:e.clientX,y:e.clientY});el.setPointerCapture(e.pointerId);
      if(points.size>1)suppressClick.current=true;
      setDragging(current.current.scale>1);
    };
    const move=(e:PointerEvent)=>{
      const prev=points.get(e.pointerId);if(!prev)return;
      const before=[...points.values()];points.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(origin&&Math.hypot(e.clientX-origin.x,e.clientY-origin.y)>4)suppressClick.current=true;
      const after=[...points.values()];
      if(before.length===2){
        const midpoint=(p:typeof before)=>({x:(p[0].x+p[1].x)/2,y:(p[0].y+p[1].y)/2});
        const distance=(p:typeof before)=>Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);
        if(distance(before)>0)put(zoomImage(current.current,distance(after)/distance(before),center(midpoint(before)),center(midpoint(after)),bounds.current));
      }else if(before.length===1)put({...current.current,x:current.current.x+e.clientX-prev.x,y:current.current.y+e.clientY-prev.y});
    };
    const up=(e:PointerEvent)=>{points.delete(e.pointerId);if(e.type==='pointercancel')suppressClick.current=true;if(el.hasPointerCapture(e.pointerId))el.releasePointerCapture(e.pointerId);if(!points.size){origin=null;setDragging(false)}};
    const blur=()=>{points.clear();origin=null;suppressClick.current=true;setDragging(false)};
    // Safari and embedded browsers can retain native page gestures despite Pointer Events.
    const lockTouch=(e:TouchEvent)=>{if(e.type==='touchmove'||e.touches.length>1)e.preventDefault()};
    el.addEventListener('touchstart',lockTouch,{passive:false});el.addEventListener('touchmove',lockTouch,{passive:false});
    el.addEventListener('wheel',wheel,{passive:false});el.addEventListener('pointerdown',down);el.addEventListener('pointermove',move);el.addEventListener('pointerup',up);el.addEventListener('pointercancel',up);el.addEventListener('lostpointercapture',up);window.addEventListener('blur',blur);
    return()=>{observer.disconnect();el.removeEventListener('touchstart',lockTouch);el.removeEventListener('touchmove',lockTouch);el.removeEventListener('wheel',wheel);el.removeEventListener('pointerdown',down);el.removeEventListener('pointermove',move);el.removeEventListener('pointerup',up);el.removeEventListener('pointercancel',up);el.removeEventListener('lostpointercapture',up);window.removeEventListener('blur',blur)};
  },[imageSize.width,imageSize.height]);
  return {area,view,fit,dragging,reset,zoom,
    backdropClick:()=>!suppressClick.current&&!onImage.current,
    doubleClick:(x:number,y:number)=>{if(current.current.scale>1)reset();else{const r=area.current!.getBoundingClientRect(),p={x:x-r.left-r.width/2,y:y-r.top-r.height/2};put(zoomImage(current.current,2,p,p,bounds.current))}},
  };
}
