import { Navigate, Route, Routes } from 'react-router-dom';

import { Home } from './pages/Home';
import { PlanView } from './pages/PlanView';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/plans/:planId" element={<PlanView />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
