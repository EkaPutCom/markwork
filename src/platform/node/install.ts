// Installs the Node platform. An entry point that runs the core on Node imports this before anything that may call
// platform().

import { setPlatform } from '../index.js';
import { nodePlatform } from './index.js';

setPlatform(nodePlatform);
