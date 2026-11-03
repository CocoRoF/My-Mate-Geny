import {test} from 'node:test';
import assert from 'node:assert/strict';
import {weightShares,sliderMaximum,frequencyLevel,cooldownPresets} from '../src/lib/triggerWeights.ts';
test('relative weights sum to 100 without changing persisted numeric values',()=>{
 const rows=[{weight:55},{weight:800},{weight:1000},{weight:17.253},{weight:0}];
 const before=structuredClone(rows),p=weightShares(rows);
 assert.ok(Math.abs(p.reduce((a,b)=>a+b,0)-100)<1e-10);assert.deepEqual(rows,before);
 assert.equal(p.at(-1),0);assert.ok(Math.abs(p[0]/p[1]-55/800)<1e-10);
 assert.equal(sliderMaximum(rows),1000);
});
test('disabled situations, all zero and very large legacy weights stay valid',()=>{
 assert.deepEqual(weightShares([{weight:0},{weight:0}]),[0,0]);
 assert.deepEqual(weightShares([{weight:1e308},{weight:1e308}]),[50,50]);
 assert.equal(sliderMaximum([{weight:12345.67}]),12345.67);
 assert.equal(frequencyLevel(0,0),0);assert.equal(frequencyLevel(55,3),1);assert.equal(frequencyLevel(55,10),2);assert.equal(frequencyLevel(55,25),3);assert.equal(frequencyLevel(55,50),4);
 assert.deepEqual(cooldownPresets,[0,10,30,60,300]);
});
