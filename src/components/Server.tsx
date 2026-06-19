import Group from './Group';
import { SnapControl, Snapcast } from '../snapcontrol';
import { SnapStream } from '../snapstream';
import { Box } from '@mui/material';


type ServerProps = {
  server: Snapcast.Server;
  snapcontrol: SnapControl;
  snapStream: SnapStream | null;
  showOffline: boolean;
  autoPlay: boolean;
};

export default function Server(props: ServerProps) {
  return (
    <Box sx={{ m: 1.5 }} >
      {props.server.groups.map(group => <Group group={group} key={group.id} server={props.server} snapcontrol={props.snapcontrol} snapStream={props.snapStream} showOffline={props.showOffline} autoPlay={props.autoPlay} />)}
    </Box>
  );
}
