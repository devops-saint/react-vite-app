import { IconButton } from '@mui/material';
import Brightness4Icon from '@mui/icons-material/Brightness4';
import Brightness7Icon from '@mui/icons-material/Brightness7';
import { useTheme } from '@contexts/ThemeContext';

export function ThemeToggle() {
  const { mode, toggleTheme } = useTheme();

  return (
    <IconButton
      color="inherit"
      onClick={toggleTheme}
      aria-label="toggle theme"
    >
      {mode === 'dark' ? <Brightness7Icon /> : <Brightness4Icon />}
    </IconButton>
  );
}
