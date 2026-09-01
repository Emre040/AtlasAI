import { BrowserRouter as Router, Route, Routes } from 'react-router-dom';

import HPA from './modules/HPA.js';
import AdminAnalytics from './modules/AdminAnalytics';

function App() {
    return (
            <Router>
                <Routes>

                <Route path="/" element={<HPA />} />
                <Route path="/admin" element={<AdminAnalytics />} />

                </Routes>
            </Router>
    );
}



export default App;
