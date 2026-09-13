import {readConfiguration} from '../src/config.js';
import {createApplication} from '../src/app.js';
import {testStore} from './firebase-fixture.js';

// A new Firestore namespace for every browser run; never populate the app's live collections.
const config=readConfiguration();const {app,worker}=createApplication({...config,store:testStore(),forwardingResolve:async()=>[{address:'8.8.8.8',family:4}]});
const server=app.listen(config.port,config.host);
process.on('SIGTERM',()=>{server.close();void worker.stop();});
