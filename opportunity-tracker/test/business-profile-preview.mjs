// Local, disposable UI fixture. It makes no model or collection requests.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTrackerApp} from '../server.mjs';
import {cafe,fixtureProvider} from './business-profile.fixture.mjs';
const directory=await mkdtemp(join(tmpdir(),'hearwhispers-profile-preview-'));
const {app,store}=createTrackerApp({dataDirectory:directory,qualificationEnv:{},businessProfileProvider:fixtureProvider(),redditAdapter:{list:async()=>({rows:[]})},discoverFn:async()=>({items:[],sources:[],searchedAt:new Date().toISOString()})});
store.saveProduct(cafe);
const server=app.listen(0,'127.0.0.1',()=>console.log(`Fixture preview: http://127.0.0.1:${server.address().port}/#products`));
async function close(){await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
