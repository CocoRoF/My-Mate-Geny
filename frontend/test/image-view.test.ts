import {test} from 'node:test';
import assert from 'node:assert/strict';
import {IMAGE_HOME,clampImageView,fittedImage,zoomImage} from '../src/components/attachments/imageView.ts';
const bounds={width:800,height:600,imageWidth:1600,imageHeight:1200};
test('images fit without stretching or upscaling small originals',()=>{
 assert.deepEqual(fittedImage(bounds),{width:800,height:600});
 assert.deepEqual(fittedImage({...bounds,imageWidth:100,imageHeight:70}),{width:100,height:70});
 assert.deepEqual(fittedImage({...bounds,width:360,height:700}),{width:360,height:270});
});
test('wheel zoom keeps the image point under the cursor and reverses without drift',()=>{
 const p={x:100,y:70},v=zoomImage(IMAGE_HOME,2,p,p,bounds);
 assert.deepEqual(v,{x:-100,y:-70,scale:2});
 assert.equal((p.x-v.x)/v.scale,p.x);assert.equal((p.y-v.y)/v.scale,p.y);
 const back=zoomImage(v,.5,p,p,bounds);assert.equal(back.scale,1);assert.equal(Math.abs(back.x),0);assert.equal(Math.abs(back.y),0);
});
test('pinch can zoom and move its midpoint in one gesture',()=>{
 const v=zoomImage(IMAGE_HOME,2,{x:50,y:20},{x:100,y:60},bounds);
 assert.equal((100-v.x)/v.scale,50);assert.equal((60-v.y)/v.scale,20);
});
test('pan never loses an image; zoom limits and resize remain bounded',()=>{
 const v=clampImageView({x:99999,y:-99999,scale:2},bounds);
 assert.deepEqual(v,{x:400,y:-300,scale:2});
 assert.equal(clampImageView({...v,scale:90},bounds).scale,8);
 const fit=clampImageView({...v,scale:.01},bounds);assert.equal(fit.scale,1);assert.equal(Math.abs(fit.x),0);assert.equal(Math.abs(fit.y),0);
 assert.deepEqual(clampImageView({...v,scale:NaN},bounds),{x:0,y:-0,scale:1});
});
