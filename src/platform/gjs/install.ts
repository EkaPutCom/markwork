// Installs the GJS platform. Every entry point (the app, the tests, the benchmarks, the capture script) imports this
// before anything that may call platform().

import { setPlatform } from '../index.js';
import { gjsPlatform } from './index.js';

setPlatform(gjsPlatform);
