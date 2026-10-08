import React from 'react';import {createRoot} from 'react-dom/client';import {App} from './App.jsx';import './styles.css';
class Boundary extends React.Component {state={failed:false};static getDerivedStateFromError(){return {failed:true};}render(){return this.state.failed?<main className="login-page"><h1>HearWhispers</h1><p>The dashboard could not load. Refresh to try again.</p><button onClick={()=>location.reload()}>Refresh dashboard</button></main>:this.props.children;}}
createRoot(document.getElementById('root')).render(<Boundary><App/></Boundary>);
