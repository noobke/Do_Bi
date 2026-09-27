import { Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import Audit from './pages/Audit'
import Chapter from './pages/Chapter'
import Characters from './pages/Characters'
import Chat from './pages/Chat'
import Disassemble from './pages/Disassemble'
import Hooks from './pages/Hooks'
import Outline from './pages/Outline'
import Projects from './pages/Projects'
import Settings from './pages/Settings'
import Style from './pages/Style'
import Workbench from './pages/Workbench'
import World from './pages/World'

/** 12 条路由与设计契约「Page List」一一对应，全部挂在共享 App Shell（Layout）之下 */
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Projects />} />
        <Route path="/workbench" element={<Workbench />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/characters" element={<Characters />} />
        <Route path="/hooks" element={<Hooks />} />
        <Route path="/outline" element={<Outline />} />
        <Route path="/chapter/:n" element={<Chapter />} />
        <Route path="/world" element={<World />} />
        <Route path="/audit" element={<Audit />} />
        <Route path="/style" element={<Style />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/disassemble" element={<Disassemble />} />
      </Route>
    </Routes>
  )
}
