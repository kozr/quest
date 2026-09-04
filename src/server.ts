import { readConfiguration } from './config.js';
import { createApplication } from './app.js';

const config=readConfiguration();
const {app,store,worker}=createApplication(config);
const server=app.listen(config.port,config.host,()=>{
  console.log(`IAP Notifications: ${config.publicUrl}`);
  console.log(config.apns ? 'APNs configured. Delivery worker enabled.' : 'APNs not configured. Activity works; phone push requires APNs credentials.');
  if(!config.production) console.log('Local MVP mode. Demo events are separate from verified Apple activity.');
  worker.start();
});
let shuttingDown=false;
async function shutdown() {
  if(shuttingDown) return;
  shuttingDown=true;
  server.close(async()=>{await worker.stop();store.close();process.exit(0);});
  setTimeout(()=>process.exit(1),20000).unref();
}
process.on('SIGINT',()=>{void shutdown();});
process.on('SIGTERM',()=>{void shutdown();});
