// Installs the Node platform. An entry point that runs the core on Node imports this before anything that may call
// platform().

import { setPlatform } from '../index';
import { nodePlatform } from './index';

setPlatform(nodePlatform);
