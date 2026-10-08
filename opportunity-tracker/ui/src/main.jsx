import React from 'react';import {createRoot} from 'react-dom/client';import {App} from './App.jsx';import './styles.css';
import {WorkspaceStartup} from './WorkspaceStartup';
class Boundary extends React.Component {state={failed:false};static getDerivedStateFromError(){return {failed:true};}render(){return this.state.failed?<WorkspaceStartup error="The dashboard could not load. Refresh to try again." onRetry={()=>location.reload()} retryLabel="Refresh workspace"/>:this.props.children;}}
createRoot(document.getElementById('root')).render(<Boundary><App/></Boundary>);
