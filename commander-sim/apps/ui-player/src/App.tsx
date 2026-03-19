import { BrowserRouter, Routes, Route } from 'react-router-dom';
import './App.css';
import MoxfieldUI from './components/MoxfieldUI';
import GameTablePage from './pages/GameTablePage';
import SpellTablePage from './pages/SpellTablePage';

declare const __SPELLTABLE_ONLY__: boolean;

function App() {
  if (__SPELLTABLE_ONLY__) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="*" element={<SpellTablePage />} />
        </Routes>
      </BrowserRouter>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<MoxfieldUI />} />
        <Route path="/game" element={<GameTablePage />} />
        <Route path="/spelltable" element={<SpellTablePage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
